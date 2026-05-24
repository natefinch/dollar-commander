# Dollar Commander pipeline

Daily TCGCSV ingestion → SQLite history → published price-index JSON.

See [../../docs/implementation-plan.md](../../docs/implementation-plan.md) for the full design.

## Local development

```
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
pytest
```
