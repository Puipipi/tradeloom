"""Run the isolated O08 PostgreSQL/Django harness for real artifact registration."""

from __future__ import annotations

import os

os.environ["TRADELOOM_O08_SCENARIO"] = "native-artifact"

from o08_postgres_native_workflow_acceptance import main


if __name__ == "__main__":
    raise SystemExit(main())
