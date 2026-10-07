"""Mirror R2 images into a new prefix; resize only images over MAX_SIDE.

Dry-run is the default. This script never deletes originals or changes Shopify.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

from PIL import Image, UnidentifiedImageError


HERE = Path(__file__).resolve().parent
ENV_FILE = HERE / ".env"
MIME_BY_FORMAT = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
FORMAT_BY_EXTENSION = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".webp": "WEBP",
}
HEADER_BYTES = 256 * 1024


def load_env(path: Path = ENV_FILE) -> None:
    if not path.is_file():
        raise ValueError(f".env fehlt: {path}")
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"Ungültige .env-Zeile: {line}")
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(name.strip(), value)


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} fehlt in .env")
    return value


def prefix(value: str, *, required_value: bool = False) -> str:
    value = value.strip().strip("/")
    if not value:
        if required_value:
            raise ValueError("R2_DEST_PREFIX darf nicht leer sein")
        return ""
    parts = value.split("/")
    if any(part in ("", ".", "..") or "\\" in part for part in parts):
        raise ValueError(f"Ungültiges Präfix: {value}")
    return value + "/"


@dataclass(frozen=True)
class Config:
    account_id: str
    access_key_id: str
    secret_access_key: str
    bucket: str
    public_url: str
    source_prefix: str
    dest_prefix: str
    max_side: int
    max_source_bytes: int


def read_config() -> Config:
    load_env()
    source_prefix = prefix(os.environ.get("R2_SOURCE_PREFIX", ""))
    dest_prefix = prefix(required("R2_DEST_PREFIX"), required_value=True)
    if source_prefix.startswith(dest_prefix):
        raise ValueError("Quellpräfix darf nicht im Zielpräfix liegen")
    max_side = int(required("MAX_SIDE"))
    max_source_mib = int(required("MAX_SOURCE_MIB"))
    if not 100 <= max_side <= 10000 or not 1 <= max_source_mib <= 1024:
        raise ValueError("MAX_SIDE oder MAX_SOURCE_MIB außerhalb des erlaubten Bereichs")
    return Config(
        account_id=required("R2_ACCOUNT_ID"),
        access_key_id=required("R2_ACCESS_KEY_ID"),
        secret_access_key=required("R2_SECRET_ACCESS_KEY"),
        bucket=required("R2_BUCKET_NAME"),
        public_url=required("R2_PUBLIC_URL").rstrip("/"),
        source_prefix=source_prefix,
        dest_prefix=dest_prefix,
        max_side=max_side,
        max_source_bytes=max_source_mib * 1024 * 1024,
    )


def connect(config: Config):
    try:
        import boto3
        from botocore.config import Config as BotoConfig
    except ImportError as exc:
        raise RuntimeError("Abhängigkeiten fehlen. Bitte requirements.txt installieren.") from exc
    return boto3.client(
        "s3",
        endpoint_url=f"https://{config.account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=config.access_key_id,
        aws_secret_access_key=config.secret_access_key,
        region_name="auto",
        config=BotoConfig(retries={"max_attempts": 5, "mode": "standard"}),
    )


def list_objects(client, bucket: str, prefix_value: str) -> list[dict]:
    paginator = client.get_paginator("list_objects_v2")
    objects = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix_value):
        objects.extend(page.get("Contents", []))
    return sorted(objects, key=lambda item: item["Key"])


def public_url(base: str, key: str) -> str:
    return base + "/" + "/".join(quote(part, safe="") for part in key.split("/"))


def destination_key(config: Config, source_key: str) -> str:
    # Legacy: Zahnfee/file.png -> motifs-v2/zahnfee/file.png
    # App: motifs/affe/uuid-file.png -> motifs-v2/affe/uuid-file.png
    parts = source_key.split("/")
    if parts[0] == "motifs":
        parts = parts[1:]
    if any(part in ("", ".", "..") or "\\" in part for part in parts):
        raise ValueError(f"Unsicherer R2-Objektschlüssel: {source_key}")
    if len(parts) == 1:
        return config.dest_prefix + "_root/" + parts[0]
    category = unicodedata.normalize("NFKD", parts[0].replace("ß", "ss"))
    category = re.sub(r"[^a-z0-9]+", "-", category.encode("ascii", "ignore").decode().lower()).strip("-")
    if not category:
        raise ValueError(f"Kategorie kann nicht normalisiert werden: {source_key}")
    return config.dest_prefix + category + "/" + "/".join(parts[1:])


def supported_format(key: str) -> str | None:
    return FORMAT_BY_EXTENSION.get(Path(key).suffix.lower())


def read_object(client, bucket: str, key: str, etag: str, max_bytes: int, *, header_only: bool):
    request = {"Bucket": bucket, "Key": key, "IfMatch": etag}
    if header_only:
        request["Range"] = f"bytes=0-{min(max_bytes, HEADER_BYTES) - 1}"
    response = client.get_object(**request)
    body = response["Body"]
    try:
        data = body.read((HEADER_BYTES if header_only else max_bytes) + 1)
    finally:
        body.close()
    if not header_only and len(data) > max_bytes:
        raise ValueError(f"Quelldatei größer als MAX_SOURCE_MIB: {key}")
    return data, response


def inspect_image(data: bytes) -> tuple[int, int, str, str]:
    with Image.open(BytesIO(data)) as image:
        if image.format not in MIME_BY_FORMAT:
            raise ValueError(f"Nicht unterstützter Bildinhalt: {image.format}")
        return image.width, image.height, image.mode, image.format


def alpha_range(image: Image.Image) -> tuple[int, int] | None:
    if image.mode == "P" and "transparency" in image.info:
        return image.convert("RGBA").getchannel("A").getextrema()
    if "A" in image.getbands():
        return image.getchannel("A").getextrema()
    return None


def make_output(source: bytes, expected_format: str, max_side: int):
    with Image.open(BytesIO(source)) as original:
        original.load()
        if original.format != expected_format:
            raise ValueError(f"Dateiendung erwartet {expected_format}, Inhalt ist {original.format}")
        size_before = original.size
        alpha_before = alpha_range(original)
        if max(size_before) <= max_side:
            return source, size_before, size_before, alpha_before, alpha_before, "copied"

        if original.mode == "P":
            resized = original.convert("RGBA" if "transparency" in original.info else "RGB")
        else:
            resized = original.copy()
        resized.thumbnail((max_side, max_side), Image.Resampling.LANCZOS, reducing_gap=3.0)
        options = {"format": expected_format}
        for metadata in ("icc_profile", "dpi", "exif"):
            if original.info.get(metadata):
                options[metadata] = original.info[metadata]
        if expected_format == "PNG":
            options["optimize"] = True
        elif expected_format == "JPEG":
            options.update(quality=95, subsampling=0, optimize=True)
        else:
            options.update(quality=95, method=6)

        buffer = BytesIO()
        resized.save(buffer, **options)
        output = buffer.getvalue()

    with Image.open(BytesIO(output)) as check:
        check.load()
        alpha_after = alpha_range(check)
        size_after = check.size
        if check.format != expected_format or max(size_after) > max_side:
            raise RuntimeError("Ausgabedatei hat falsches Format oder falsche Abmessungen")
        if alpha_before is not None and alpha_after is None:
            raise RuntimeError("Transparenzkanal ging verloren")
        if abs(size_before[0] * size_after[1] - size_before[1] * size_after[0]) > max(size_before):
            raise RuntimeError("Seitenverhältnis wurde verändert")
    return output, size_before, size_after, alpha_before, alpha_after, "resized"


def run(client, config: Config, *, apply: bool, limit: int | None, report_path: Path) -> dict:
    source_objects = list_objects(client, config.bucket, config.source_prefix)
    target_keys = {item["Key"] for item in list_objects(client, config.bucket, config.dest_prefix)}
    eligible = [
        item for item in source_objects
        if not item["Key"].startswith(config.dest_prefix)
        and not item["Key"].endswith("/")
        and supported_format(item["Key"])
    ]
    if limit is not None:
        eligible = eligible[:limit]
    destination_counts = Counter(destination_key(config, item["Key"]) for item in eligible)
    collisions = [key for key, count in destination_counts.items() if count > 1]
    if collisions:
        raise ValueError(
            f"{len(collisions)} Zielpfad-Kollision(en); keine Uploads gestartet. Beispiele: {collisions[:5]}"
        )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    counts = {"planned_copy": 0, "planned_resize": 0, "copied": 0, "resized": 0, "exists": 0, "failed": 0}

    with report_path.open("w", encoding="utf-8") as report:
        for index, item in enumerate(eligible, 1):
            key = item["Key"]
            target = destination_key(config, key)
            row = {
                "source_key": key,
                "destination_key": target,
                "source_url": public_url(config.public_url, key),
                "destination_url": public_url(config.public_url, target),
                "source_bytes": item["Size"],
            }
            try:
                if target in target_keys:
                    row["status"] = "exists"
                elif item["Size"] > config.max_source_bytes:
                    raise ValueError("Quelldatei größer als MAX_SOURCE_MIB")
                else:
                    extension_format = supported_format(key)
                    header, _ = read_object(client, config.bucket, key, item["ETag"], config.max_source_bytes, header_only=True)
                    try:
                        width, height, mode, actual_format = inspect_image(header)
                    except (UnidentifiedImageError, OSError, ValueError):
                        # Some files have a large metadata header; inspect the full object.
                        full, _ = read_object(client, config.bucket, key, item["ETag"], config.max_source_bytes, header_only=False)
                        width, height, mode, actual_format = inspect_image(full)
                    row.update(
                        source_dimensions=[width, height], source_mode=mode,
                        source_format=actual_format,
                        extension_mismatch=actual_format != extension_format,
                    )
                    if not apply:
                        row["status"] = "planned_resize" if max(width, height) > config.max_side else "planned_copy"
                    else:
                        full, _ = read_object(client, config.bucket, key, item["ETag"], config.max_source_bytes, header_only=False)
                        output, before, after, alpha_before, alpha_after, action = make_output(full, actual_format, config.max_side)
                        response = client.put_object(
                            Bucket=config.bucket,
                            Key=target,
                            Body=output,
                            ContentType=MIME_BY_FORMAT[actual_format],
                            CacheControl="public, max-age=31536000, immutable",
                            IfNoneMatch="*",  # Never overwrite an existing target.
                        )
                        head = client.head_object(Bucket=config.bucket, Key=target)
                        if head["ContentLength"] != len(output) or head["ContentType"] != MIME_BY_FORMAT[actual_format]:
                            raise RuntimeError("R2-Prüfung nach Upload fehlgeschlagen")
                        row.update(
                            status=action,
                            destination_dimensions=list(after),
                            destination_bytes=len(output),
                            source_sha256=hashlib.sha256(full).hexdigest(),
                            destination_sha256=hashlib.sha256(output).hexdigest(),
                            source_alpha=alpha_before,
                            destination_alpha=alpha_after,
                            etag=response.get("ETag"),
                        )
                        target_keys.add(target)
            except Exception as exc:
                row.update(status="failed", error=f"{type(exc).__name__}: {exc}")
            counts[row["status"]] += 1
            report.write(json.dumps(row, ensure_ascii=False) + "\n")
            report.flush()
            dimensions = row.get("source_dimensions", "")
            print(f"[{index}/{len(eligible)}] {row['status']:14} {key} {dimensions}", flush=True)

    print(f"Bericht: {report_path}")
    print("Ergebnis:", counts)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Neue R2-Objekte wirklich schreiben; Standard ist Dry-Run")
    parser.add_argument("--limit", type=int, help="Nur die ersten N passenden Bilder prüfen")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit muss mindestens 1 sein")
    config = read_config()
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"{mode}: Bucket {config.bucket}, Quelle {config.source_prefix or '(alle)'}, Ziel {config.dest_prefix}")
    print("Originale werden nie gelöscht oder überschrieben. Shopify-Einträge bleiben unverändert.")
    report_path = HERE / "reports" / f"r2-resize-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{mode.lower()}.jsonl"
    counts = run(connect(config), config, apply=args.apply, limit=args.limit, report_path=report_path)
    if counts["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
