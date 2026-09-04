#!/usr/bin/env python3
"""Not Name: payload build and unpack tool.

  unpack   payload.enc + master password  ->  build/  (plaintext working tree)
  pack     build/                         ->  payload.enc

The working tree under build/ is plaintext and holds every password. It is
gitignored and must never be committed.
"""

import argparse
import base64
import gzip
import json
import os
import re
import shutil
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DEFAULT_ITER = 600_000
LINK_RE = re.compile(r"\[([^\]]+)\]\(#/work/([A-Za-z0-9\-]+)\)")


# --------------------------------------------------------------------------
# crypto

def derive(password, salt, iterations):
    return PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations
    ).derive(password.encode("utf-8"))


def seal(obj, password, iterations, use_gzip):
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if use_gzip:
        raw = gzip.compress(raw, 9, mtime=0)
    salt = os.urandom(16)
    iv = os.urandom(12)
    ct = AESGCM(derive(password, salt, iterations)).encrypt(iv, raw, None)
    b64 = lambda v: base64.b64encode(v).decode("ascii")
    return {"salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def unseal(entry, password, iterations, use_gzip):
    b = base64.b64decode
    key = derive(password, b(entry["salt"]), iterations)
    raw = AESGCM(key).decrypt(b(entry["iv"]), b(entry["ct"]), None)
    if use_gzip:
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


# --------------------------------------------------------------------------
# catalogue filtering

def prune_catalog(catalog, excluded):
    """Copy of the catalogue without excluded slugs. Subsections and
    categories left with no works are dropped, so no empty header survives."""
    out = {}
    for category, subsections in catalog.items():
        kept_subs = {}
        for subsection, works in subsections.items():
            kept = [w for w in works if w.get("shortname") not in excluded]
            if kept:
                kept_subs[subsection] = kept
        if kept_subs:
            out[category] = kept_subs
    return out


def catalog_slugs(catalog):
    return [
        w["shortname"]
        for subsections in catalog.values()
        for works in subsections.values()
        for w in works
        if w.get("shortname")
    ]


def degrade_links(work, visible, report):
    """Turn [label](#/work/slug) into plain label where slug is not visible."""
    def fix(container, field):
        value = container.get(field)
        if not isinstance(value, list):
            return
        for i, line in enumerate(value):
            if not isinstance(line, str):
                continue
            def sub(m):
                if m.group(2) in visible:
                    return m.group(0)
                report.append(m.group(2))
                return m.group(1)
            value[i] = LINK_RE.sub(sub, line)

    fix(work, "content")
    fix(work, "footnotes")
    return work


# --------------------------------------------------------------------------
# pack

def cmd_pack(args):
    src = args.src
    cfg = json.load(open(os.path.join(src, "profiles.json"), encoding="utf-8"))
    iterations = int(cfg.get("iter", DEFAULT_ITER))
    use_gzip = bool(cfg.get("gzip", True))
    link_policy = cfg.get("linkPolicy", "degrade")

    html = open(os.path.join(src, "app.html"), encoding="utf-8").read()
    css = open(os.path.join(src, "app.css"), encoding="utf-8").read()
    js = open(os.path.join(src, "app.js"), encoding="utf-8").read()
    catalog = json.load(open(os.path.join(src, "data", "index.json"), encoding="utf-8"))

    all_slugs = catalog_slugs(catalog)
    works = {}
    for slug in all_slugs:
        path = os.path.join(src, "data", slug + ".json")
        if not os.path.exists(path):
            sys.exit("missing work file for catalogue entry: " + slug)
        works[slug] = json.load(open(path, encoding="utf-8"))

    profiles = cfg["profiles"]
    ids = [p["id"] for p in profiles]
    if len(set(ids)) != len(ids):
        sys.exit("duplicate profile id")
    passwords = [p["password"] for p in profiles]
    if len(set(passwords)) != len(passwords):
        sys.exit("two profiles share a password")
    if sum(1 for p in profiles if p.get("master")) != 1:
        sys.exit("exactly one profile must be marked master")

    roster = {
        "profiles": [
            {
                "id": p["id"],
                "label": p.get("label", p["id"]),
                "password": p["password"],
                "master": bool(p.get("master")),
                "exclude": list(p.get("exclude", [])),
                "note": p.get("note", ""),
            }
            for p in profiles
        ]
    }

    built = []
    for p in profiles:
        excluded = set(p.get("exclude", []))
        unknown = excluded - set(all_slugs)
        if unknown:
            sys.exit("profile %s excludes unknown slug(s): %s"
                     % (p["id"], ", ".join(sorted(unknown))))

        view = prune_catalog(catalog, excluded)
        visible = set(catalog_slugs(view))

        data = {"data/index.json": json.dumps(view, ensure_ascii=False)}
        broken = []
        for slug in visible:
            work = json.loads(json.dumps(works[slug]))
            if link_policy == "degrade":
                work = degrade_links(work, visible, broken)
            data["data/" + slug + ".json"] = json.dumps(work, ensure_ascii=False)

        bundle = {
            "html": html,
            "css": css,
            "js": js,
            "data": data,
            "hide": [],
            "profile": {"id": p["id"], "label": p.get("label", p["id"])},
        }
        if p.get("master"):
            bundle["data"]["data/roster.json"] = json.dumps(roster, ensure_ascii=False)

        entry = seal(bundle, p["password"], iterations, use_gzip)
        built.append(entry)

        print("  %-12s %2d/%-2d works, %2d categories, %6.1f kB%s"
              % (p["id"], len(visible), len(all_slugs), len(view),
                 len(entry["ct"]) * 0.75 / 1024,
                 ", %d link(s) flattened" % len(broken) if broken else ""))

    payload = {"iter": iterations, "gzip": use_gzip, "profiles": built}
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print("wrote %s (%.1f kB, %d profiles)"
          % (args.out, os.path.getsize(args.out) / 1024, len(built)))


# --------------------------------------------------------------------------
# unpack

def cmd_unpack(args):
    payload = json.load(open(args.payload, encoding="utf-8"))
    iterations = int(payload.get("iter", DEFAULT_ITER))
    use_gzip = bool(payload.get("gzip", True))

    bundle = None
    for entry in payload["profiles"]:
        try:
            bundle = unseal(entry, args.password, iterations, use_gzip)
            break
        except Exception:
            continue
    if bundle is None:
        sys.exit("no profile opens with that password")
    if "data/roster.json" not in bundle.get("data", {}):
        sys.exit("that password opens a subset profile, not the master; "
                 "unpack needs the master password")

    out = args.out
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, "data"))
    open(os.path.join(out, "app.html"), "w", encoding="utf-8").write(bundle["html"])
    open(os.path.join(out, "app.css"), "w", encoding="utf-8").write(bundle["css"])
    open(os.path.join(out, "app.js"), "w", encoding="utf-8").write(bundle["js"])
    for key, value in bundle["data"].items():
        if key == "data/roster.json":
            continue
        obj = json.loads(value)
        path = os.path.join(out, key)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)

    roster = json.loads(bundle["data"]["data/roster.json"])
    cfg = {
        "iter": iterations,
        "gzip": use_gzip,
        "linkPolicy": "degrade",
        "profiles": roster["profiles"],
    }
    with open(os.path.join(out, "profiles.json"), "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    print("unpacked %d works and %d profiles into %s/"
          % (len(bundle["data"]) - 2, len(roster["profiles"]), out))


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(prog="nn.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("pack", help="build payload.enc from a working tree")
    p.add_argument("--src", default="build")
    p.add_argument("--out", default="payload.enc")
    p.set_defaults(func=cmd_pack)

    u = sub.add_parser("unpack", help="open payload.enc into a working tree")
    u.add_argument("password")
    u.add_argument("--payload", default="payload.enc")
    u.add_argument("--out", default="build")
    u.set_defaults(func=cmd_unpack)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
