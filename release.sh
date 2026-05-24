#!/usr/bin/env bash
set -euo pipefail

# Creates a git tag, builds Chrome and Firefox extension packages, signs the
# Firefox extension via AMO, and creates a draft GitHub release.

BUMP="minor"
NO_BUMP=false
DRYRUN=false
for arg in "$@"; do
  case "$arg" in
    --patch) BUMP="patch" ;;
    --nobump|--no-bump) NO_BUMP=true ;;
    --dryrun) DRYRUN=true ;;
    *)
      echo "Usage: $0 [--patch | --nobump] [--dryrun]"
      echo "  Unknown argument: $arg"
      exit 1
      ;;
  esac
done

if [[ "$NO_BUMP" == true && "$BUMP" != "minor" ]]; then
  echo "Error: --nobump cannot be combined with --patch"
  exit 1
fi

CURRENT=$(node -e "import{readFileSync as r}from'fs';console.log(JSON.parse(r('manifests/base.json','utf8')).version)")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

if [[ "$NO_BUMP" == true ]]; then
  VERSION="$CURRENT"
  BUMP_LABEL="no version bump"
elif [[ "$BUMP" == "patch" ]]; then
  VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
  BUMP_LABEL="$BUMP bump"
else
  VERSION="${MAJOR}.$((MINOR + 1)).0"
  BUMP_LABEL="$BUMP bump"
fi

TAG="v${VERSION}"
CHROME_ZIP="dollar-commander-chrome-${TAG}.zip"
FIREFOX_XPI="dollar-commander-firefox-${TAG}.xpi"
UNSIGNED_FIREFOX_ZIP="dollar-commander-firefox-unsigned-${TAG}.zip"
UPDATE_MANIFEST="dollar-commander-firefox-updates.json"

echo "Current version: $CURRENT -> releasing $TAG ($BUMP_LABEL)"

if $DRYRUN; then
  echo "[dry run] Would build Chrome and Firefox extensions"
  echo "[dry run] Would create $CHROME_ZIP, $FIREFOX_XPI, and $UPDATE_MANIFEST"
  echo "[dry run] Would create a draft GitHub release"
  exit 0
fi

for command in gh git node zip; do
  if ! command -v "$command" &>/dev/null; then
    echo "Error: $command is required."
    exit 1
  fi
done

missing=()
[[ -z "${AMO_JWT_ISSUER:-}" ]] && missing+=("AMO_JWT_ISSUER")
[[ -z "${AMO_JWT_SECRET:-}" ]] && missing+=("AMO_JWT_SECRET")
if (( ${#missing[@]} > 0 )); then
  echo "Error: missing required environment variables:"
  printf '  %s\n' "${missing[@]}"
  exit 1
fi

if [[ ! -f manifests/base.json ]]; then
  echo "Error: must be run from the dollar-commander repo root"
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on the main branch to release (currently on: $BRANCH)"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: you have uncommitted changes. Please commit or stash them first."
  exit 1
fi

if git rev-parse "$TAG" &>/dev/null; then
  echo "Error: tag $TAG already exists."
  exit 1
fi

write_version_files() {
  local target_version="$1"
  node - "$target_version" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'fs';

const version = process.argv[2];

function updateJson(path, update) {
  if (!existsSync(path)) return;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  update(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ${path}`);
}

updateJson('manifests/base.json', json => {
  json.version = version;
});
updateJson('package.json', json => {
  json.version = version;
});
updateJson('package-lock.json', json => {
  json.version = version;
  if (json.packages?.['']) json.packages[''].version = version;
});
NODE
}

cleanup() {
  rm -f "$CHROME_ZIP" "$FIREFOX_XPI" "$UNSIGNED_FIREFOX_ZIP" "$UPDATE_MANIFEST"
  rm -rf web-ext-artifacts/
}
trap cleanup EXIT

if [[ "$NO_BUMP" == false ]]; then
  echo "Updating version to $VERSION..."
  write_version_files "$VERSION"
fi

echo "Building extensions..."
npm run build

echo "Packaging $CHROME_ZIP..."
(cd dist/chrome && COPYFILE_DISABLE=1 zip -r -X "../../$CHROME_ZIP" . -x '__MACOSX/*' '*/.*' '.*')

echo "Signing Firefox extension..."
(cd dist/firefox && COPYFILE_DISABLE=1 zip -r -X "../../$UNSIGNED_FIREFOX_ZIP" . -x '__MACOSX/*' '*/.*' '.*')
node scripts/sign-firefox.mjs \
  --input "$UNSIGNED_FIREFOX_ZIP" \
  --source-dir dist/firefox \
  --output "$FIREFOX_XPI" \
  --artifacts-dir web-ext-artifacts
rm "$UNSIGNED_FIREFOX_ZIP"

echo "Writing Firefox update manifest..."
node - "$VERSION" "$TAG" "$FIREFOX_XPI" "$UPDATE_MANIFEST" <<'NODE'
import { writeFileSync } from 'fs';

const [version, tag, xpiName, output] = process.argv.slice(2);
const updateManifest = {
  addons: {
    'dollar-commander@natefinch.com': {
      updates: [
        {
          version,
          update_link: `https://github.com/natefinch/dollar-commander/releases/download/${tag}/${xpiName}`,
        },
      ],
    },
  },
};

writeFileSync(output, JSON.stringify(updateManifest, null, 2) + '\n');
NODE

if [[ "$NO_BUMP" == false ]]; then
  git add manifests/base.json package.json
  [[ -f package-lock.json ]] && git add package-lock.json
  git commit -m "Release $TAG"
fi

git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"

gh release create "$TAG" "$CHROME_ZIP" "$FIREFOX_XPI" "$UPDATE_MANIFEST" \
  --repo natefinch/dollar-commander \
  --title "Dollar Commander $TAG" \
  --notes "Draft release for Dollar Commander $TAG." \
  --draft

git push origin main
trap - EXIT
cleanup

echo "Done: https://github.com/natefinch/dollar-commander/releases/tag/$TAG"

