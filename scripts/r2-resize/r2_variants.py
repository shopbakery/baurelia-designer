"""Generate transparent WebP thumbnail/preview variants from motifs-v2 masters.

Dry-run is the default. No source object is deleted or overwritten, and no
Shopify data is changed. Use --apply only after checking a category dry-run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps, features

from r2_resize import (
    HERE,
    alpha_range,
    connect,
    list_objects,
    load_env,
    prefix,
    public_url,
    read_object,
    required,
    supported_format,
)


SOURCE_PREFIX = "motifs-v2/"
VARIANTS = {
    "thumbnail": ("motifs-v2-thumbs/", 300),
    "preview": ("motifs-v2-previews/", 900),
}
WEBP_QUALITY = 82
MAX_INPUT_PIXELS = 40_000_000
CACHE_CONTROL = "public, max-age=31536000, immutable"


@dataclass(frozen=True)
class Config:
    account_id: str
    access_key_id: str
    secret_access_key: str
    bucket: str
    public_url: str
    max_source_bytes: int


def read_config() -> Config:
    load_env()
    configured_source = prefix(required("R2_DEST_PREFIX"), required_value=True)
    if configured_source != SOURCE_PREFIX:
        raise ValueError(f"R2_DEST_PREFIX muss für dieses Skript {SOURCE_PREFIX} sein")
    max_source_mib = int(required("MAX_SOURCE_MIB"))
    if not 1 <= max_source_mib <= 1024:
        raise ValueError("MAX_SOURCE_MIB außerhalb des erlaubten Bereichs")
    if not features.check("webp"):
        raise RuntimeError("Diese Pillow-Installation unterstützt WebP nicht")
    return Config(
        account_id=required("R2_ACCOUNT_ID"),
        access_key_id=required("R2_ACCESS_KEY_ID"),
        secret_access_key=required("R2_SECRET_ACCESS_KEY"),
        bucket=required("R2_BUCKET_NAME"),
        public_url=required("R2_PUBLIC_URL").rstrip("/"),
        max_source_bytes=max_source_mib * 1024 * 1024,
    )


def variant_keys(source_key: str) -> dict[str, str]:
    if not source_key.startswith(SOURCE_PREFIX):
        raise ValueError(f"Quelle liegt nicht unter {SOURCE_PREFIX}: {source_key}")
    relative_key = source_key[len(SOURCE_PREFIX):]
    segments = relative_key.split("/")
    if (
        len(segments) < 2
        or any(segment in ("", ".", "..") or "\\" in segment for segment in segments)
        or not supported_format(source_key)
    ):
        raise ValueError(f"Ungültiger Motivschlüssel: {source_key}")
    # Keep the full original filename, including its extension, to avoid
    # collisions between e.g. motif.png and motif.jpg.
    return {
        name: f"{target_prefix}{relative_key}.webp"
        for name, (target_prefix, _) in VARIANTS.items()
    }


def make_variants(source: bytes, names: tuple[str, ...]) -> tuple[dict, dict]:
    with Image.open(BytesIO(source)) as original:
        if original.format not in ("PNG", "JPEG", "WEBP"):
            raise ValueError(f"Nicht unterstützter Bildinhalt: {original.format}")
        if getattr(original, "n_frames", 1) != 1:
            raise ValueError("Animierte Bilder werden nicht verarbeitet")
        if original.width * original.height > MAX_INPUT_PIXELS:
            raise ValueError(f"Bild überschreitet {MAX_INPUT_PIXELS} Pixel")
        original.load()
        oriented = ImageOps.exif_transpose(original)
        alpha_before = alpha_range(oriented)
        has_transparency = alpha_before is not None and alpha_before[0] < 255
        image = oriented.convert("RGBA" if has_transparency else "RGB")
        before = image.size
        icc_profile = original.info.get("icc_profile") if original.mode in ("RGB", "RGBA", "P") else None

        results = {}
        for name in names:
            max_side = VARIANTS[name][1]
            resized = image.copy()
            resized.thumbnail((max_side, max_side), Image.Resampling.LANCZOS, reducing_gap=3.0)
            buffer = BytesIO()
            options = {
                "format": "WEBP",
                "quality": WEBP_QUALITY,
                "alpha_quality": 100,
                "method": 6,
                "exact": True,
            }
            if icc_profile:
                options["icc_profile"] = icc_profile
            resized.save(buffer, **options)
            output = buffer.getvalue()
            with Image.open(BytesIO(output)) as check:
                check.load()
                alpha_after = alpha_range(check)
                if check.format != "WEBP" or max(check.size) > max_side:
                    raise RuntimeError(f"{name}: falsches Format oder zu große Abmessungen")
                if has_transparency and (alpha_after is None or alpha_after[0] == 255):
                    raise RuntimeError(f"{name}: Transparenz ging verloren")
                if abs(before[0] * check.height - before[1] * check.width) > max(before):
                    raise RuntimeError(f"{name}: Seitenverhältnis wurde verändert")
                results[name] = {
                    "data": output,
                    "dimensions": list(check.size),
                    "alpha": alpha_after,
                    "sha256": hashlib.sha256(output).hexdigest(),
                }

    return results, {
        "source_dimensions": list(before),
        "source_format": original.format,
        "source_alpha": alpha_before,
    }


def verify_existing(client, bucket: str, key: str) -> None:
    head = client.head_object(Bucket=bucket, Key=key)
    if head.get("ContentType") != "image/webp" or head.get("ContentLength", 0) <= 0:
        raise RuntimeError(f"Vorhandene Zieldatei ist ungültig: {key}")


def run(client, config: Config, *, apply: bool, category: str | None, limit: int | None, report_path: Path) -> dict:
    source_prefix = SOURCE_PREFIX + (f"{category}/" if category else "")
    sources = [
        item for item in list_objects(client, config.bucket, source_prefix)
        if not item["Key"].endswith("/") and supported_format(item["Key"])
    ]
    if limit is not None:
        sources = sources[:limit]
    if not sources:
        raise ValueError(f"Keine passenden Bilder unter {source_prefix} gefunden")

    # Validate every key and collision before the first possible write.
    pairs = [(item, variant_keys(item["Key"])) for item in sources]
    all_targets = [key for _, targets in pairs for key in targets.values()]
    if len(all_targets) != len(set(all_targets)):
        raise ValueError("Zielpfad-Kollision; keine Uploads gestartet")

    existing = {
        name: {item["Key"] for item in list_objects(client, config.bucket, target_prefix)}
        for name, (target_prefix, _) in VARIANTS.items()
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    counts = Counter({"planned": 0, "created": 0, "exists": 0, "failed": 0})

    with report_path.open("x", encoding="utf-8") as report:
        for index, (item, targets) in enumerate(pairs, 1):
            source_key = item["Key"]
            row = {
                "source_key": source_key,
                "source_bytes": item["Size"],
                "source_etag": item["ETag"],
                "targets": {},
            }
            try:
                if item["Size"] > config.max_source_bytes:
                    raise ValueError("Quelldatei größer als MAX_SOURCE_MIB")
                needed = tuple(name for name in VARIANTS if targets[name] not in existing[name])
                if apply:
                    for name in VARIANTS:
                        if name not in needed:
                            verify_existing(client, config.bucket, targets[name])
                    if needed:
                        source, _ = read_object(
                            client, config.bucket, source_key, item["ETag"],
                            config.max_source_bytes, header_only=False,
                        )
                        built, details = make_variants(source, needed)
                        row.update(details, source_sha256=hashlib.sha256(source).hexdigest())

                for name in VARIANTS:
                    target = targets[name]
                    entry = {"key": target, "url": public_url(config.public_url, target)}
                    if name not in needed:
                        entry["status"] = "exists"
                    elif not apply:
                        entry["status"] = "planned"
                    else:
                        output = built[name]
                        client.put_object(
                            Bucket=config.bucket,
                            Key=target,
                            Body=output["data"],
                            ContentType="image/webp",
                            CacheControl=CACHE_CONTROL,
                            IfNoneMatch="*",
                        )
                        verify_existing(client, config.bucket, target)
                        entry.update(
                            status="created",
                            bytes=len(output["data"]),
                            dimensions=output["dimensions"],
                            alpha=output["alpha"],
                            sha256=output["sha256"],
                        )
                        existing[name].add(target)
                    row["targets"][name] = entry
                    counts[entry["status"]] += 1
            except Exception as exc:
                row.update(error=f"{type(exc).__name__}: {exc}")
                counts["failed"] += 1

            report.write(json.dumps(row, ensure_ascii=False) + "\n")
            report.flush()
            statuses = ", ".join(f"{name}={item['status']}" for name, item in row["targets"].items())
            print(f"[{index}/{len(pairs)}] {source_key}: {statuses or row.get('error')}", flush=True)

    print(f"Bericht: {report_path}")
    print("Ergebnis:", dict(counts))
    return dict(counts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Neue R2-Objekte schreiben; Standard ist Dry-Run")
    parser.add_argument("--category", help="Nur eine Kategorie, z. B. zahnfee")
    parser.add_argument("--limit", type=int, help="Nur die ersten N passenden Motive prüfen")
    args = parser.parse_args()
    if args.category and not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.category):
        parser.error("--category muss ein Kategorie-Handle sein, z. B. zahnfee")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit muss mindestens 1 sein")

    config = read_config()
    mode = "apply" if args.apply else "dry-run"
    scope = args.category or "alle Kategorien"
    print(f"{mode.upper()}: Bucket {config.bucket}, Quelle {SOURCE_PREFIX}, Kategorie {scope}")
    print("Druckbilder werden nie gelöscht oder überschrieben. Shopify-Einträge bleiben unverändert.")
    report_path = HERE / "reports" / f"r2-variants-{datetime.now(timezone.utc):%Y%m%d-%H%M%S-%f}-{mode}.jsonl"
    counts = run(connect(config), config, apply=args.apply, category=args.category, limit=args.limit, report_path=report_path)
    if counts["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
