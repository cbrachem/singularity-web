"""The trace harness: Scenario format, the reference recorder, and the digest manifest.

`scenario.py` defines the file format both implementations consume. `reference.py` drives
the pinned reference simulation through one and emits a Trace. `manifest.py` keeps the
committed digest manifest, which is a tripwire on the specification changing rather than
the fidelity check itself.
"""
