#!/usr/bin/env bash
# Land profiles-multi-password on main and deploy. Run from the repo root.
set -euo pipefail
git diff --quiet && git diff --cached --quiet || { echo "working tree dirty; commit or stash first"; exit 1; }
python3 tools/nn.py pack --src build --out payload.enc
git add -A
git diff --cached --quiet || git commit -q -m "Rebuild payload.enc"
git checkout main
git merge --ff-only profiles-multi-password
git push origin main
echo "shipped: $(git rev-parse --short HEAD) -> notname.yashmoitra.com"
