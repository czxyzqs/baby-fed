"""Monthly JSON records with serialized access and recoverable commits."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid


CN_TZ = timezone(timedelta(hours=8))
SETTING_FILES = (
    'supplement_settings.json',
    'medicine_settings.json',
    'fever_mode.json',
    'reminder_state.json',
)
MONTH_PATTERN = re.compile(r'[0-9]{4}-(?:0[1-9]|1[0-2])')
BACKUP_PATTERN = re.compile(r'(?:records|snapshot|migration|before_restore)_[0-9A-Za-z_]+\.json')
logger = logging.getLogger(__name__)


class StorageError(RuntimeError):
    """The store cannot be read or safely committed."""


class StorageValidationError(ValueError):
    """A record or backup is not a valid storage input."""


class BackupNotFoundError(LookupError):
    """The requested backup does not exist."""


def record_time(record):
    value = record.get('time')
    if not isinstance(value, str) or not value:
        raise StorageValidationError(f"Record {record.get('id')!r} has no valid time")
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=CN_TZ)
        return parsed.astimezone(CN_TZ)
    except (ValueError, OverflowError) as exc:
        raise StorageValidationError(f"Record {record.get('id')!r} has an invalid time") from exc


def validate_records(records):
    if not isinstance(records, list):
        raise StorageValidationError('Records must be a JSON array')
    identifiers = set()
    for record in records:
        if not isinstance(record, dict):
            raise StorageValidationError('Every record must be a JSON object')
        identifier = record.get('id')
        if not isinstance(identifier, str) or not identifier:
            raise StorageValidationError('Every record must have a nonempty string id')
        if identifier in identifiers:
            raise StorageValidationError(f'Duplicate record id: {identifier}')
        identifiers.add(identifier)
        record_time(record)
    try:
        json.dumps(records, ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, TypeError) as exc:
        raise StorageValidationError('Records must contain valid, finite UTF-8 JSON values') from exc


def month_key(value):
    local = value.astimezone(CN_TZ) if value.tzinfo else value.replace(tzinfo=CN_TZ)
    return f'{local.year:04d}-{local.month:02d}'


def checksum(value):
    content = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, value):
    content = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8', dir=path.parent,
            prefix=f'.{path.name}.', suffix='.tmp', delete=False,
        ) as output:
            temporary_path = Path(output.name)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
        sync_directory(path.parent)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


class JsonRecordStore:
    def __init__(self, data_dir, backup_interval=3600):
        self.root = Path(data_dir).resolve()
        self.backup_interval = backup_interval
        self._local = threading.local()

    @contextmanager
    def locked(self):
        """Serialize threads/processes, including validation and multi-file reads."""
        if getattr(self._local, 'active', False):
            yield self
            return
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            for name in ('records', 'transactions', 'backups'):
                directory = self.root / name
                if directory.is_symlink():
                    raise StorageError(f'Storage directory must not be a symlink: {name}')
                if not directory.exists():
                    directory.mkdir(exist_ok=True)
                    sync_directory(self.root)
            lock_path = self.root / '.storage.lock'
            if lock_path.is_symlink():
                raise StorageError('Storage lock must not be a symlink')
            with lock_path.open('a+b') as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                self._local.active = True
                try:
                    self._recover()
                    self._initialize()
                    yield self
                finally:
                    self._local.active = False
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        except OSError as exc:
            raise StorageError(f'Storage I/O failed: {exc}') from exc

    def _read_json(self, path):
        if path.is_symlink():
            raise StorageError(f'Storage file must not be a symlink: {path.name}')
        try:
            with path.open(encoding='utf-8') as source:
                return json.load(source)
        except (OSError, ValueError, UnicodeError) as exc:
            raise StorageError(f'Cannot read {path.name}: {exc}') from exc

    def _validate_metadata(self, metadata):
        if not isinstance(metadata, dict) or metadata.get('format') != 1:
            raise StorageError('Invalid storage metadata format')
        months = metadata.get('months')
        if (
            not isinstance(months, list)
            or any(not isinstance(month, str) or not MONTH_PATTERN.fullmatch(month) for month in months)
            or months != sorted(set(months))
            or not isinstance(metadata.get('version'), str)
            or not metadata['version']
        ):
            raise StorageError('Invalid storage metadata')

    def _validate_setting(self, name, value):
        if name not in SETTING_FILES:
            raise StorageValidationError('Unknown settings file')
        if value is None:
            return
        if not isinstance(value, dict):
            raise StorageValidationError(f'{name} must contain a JSON object')
        try:
            json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        except (ValueError, TypeError) as exc:
            raise StorageValidationError(f'{name} must contain valid, finite UTF-8 JSON values') from exc
        if name == 'reminder_state.json':
            sent = value.get('sent')
            if not isinstance(sent, dict) or any(not isinstance(item, dict) for item in sent.values()):
                raise StorageValidationError('Invalid reminder state')

    def _initialize(self):
        metadata_path = self.root / 'metadata.json'
        if metadata_path.exists():
            self._local.metadata = self._read_json(metadata_path)
            self._validate_metadata(self._local.metadata)
            if self._read_json(self.root / 'layout.json') != {'format': 1}:
                raise StorageError('Invalid storage layout marker')
            return
        if (self.root / 'layout.json').exists() or list((self.root / 'records').glob('*.json')):
            raise StorageError('Initialized store has no metadata; restore a complete backup')
        legacy_path = self.root / 'records.json'
        records = self._read_json(legacy_path) if legacy_path.exists() else []
        try:
            validate_records(records)
            settings = self._settings_snapshot()
        except StorageValidationError as exc:
            raise StorageError(f'Migration stopped without changing legacy data: {exc}') from exc
        self._local.metadata = {'format': 1, 'version': uuid.uuid4().hex, 'months': []}
        if legacy_path.exists():
            self._write_backup('migration', records=records, settings=settings)
        writes = self._group_records(records)
        writes['layout.json'] = {'format': 1}
        self._commit(writes, records_changed=True, backup=False)
        logger.info('Initialized monthly JSON storage: %d records, %d months', len(records), len(self._local.metadata['months']))

    def _target(self, name):
        if name not in (*SETTING_FILES, 'metadata.json', 'layout.json'):
            if not isinstance(name, str) or not re.fullmatch(r'records/[0-9]{4}-(?:0[1-9]|1[0-2])\.json', name):
                raise StorageError('Invalid transaction target')
        target = self.root / name
        if target.is_symlink() or target.parent.resolve() not in (self.root, self.root / 'records'):
            raise StorageError('Unsafe transaction target')
        return target

    def _apply_transaction(self, transaction):
        if not isinstance(transaction, dict) or transaction.get('format') != 1:
            raise StorageError('Invalid transaction journal')
        writes = transaction.get('writes')
        if not isinstance(writes, dict) or 'metadata.json' not in writes:
            raise StorageError('Transaction has no metadata')
        try:
            if checksum(writes) != transaction.get('checksum'):
                raise StorageError('Transaction checksum mismatch')
            self._validate_metadata(writes['metadata.json'])
            for name, value in writes.items():
                self._target(name)
                if name.startswith('records/') and value is not None:
                    validate_records(value)
                    if any(self._shard_name(record) != name for record in value):
                        raise StorageError('Transaction record belongs to another month')
                elif name in SETTING_FILES:
                    self._validate_setting(name, value)
                elif name == 'layout.json' and value != {'format': 1}:
                    raise StorageError('Invalid transaction layout marker')
        except (StorageValidationError, TypeError, ValueError) as exc:
            raise StorageError(f'Invalid transaction content: {exc}') from exc
        for name in sorted(writes, key=lambda name: (name == 'metadata.json', name)):
            target = self._target(name)
            if writes[name] is None:
                target.unlink(missing_ok=True)
                sync_directory(target.parent)
            else:
                atomic_json(target, writes[name])

    def _recover(self):
        journal = self.root / 'transactions' / 'pending.json'
        if not journal.exists():
            return
        transaction = self._read_json(journal)
        self._apply_transaction(transaction)
        journal.unlink()
        sync_directory(journal.parent)
        logger.warning('Recovered JSON transaction %s', transaction.get('id'))

    def _commit(self, writes, records_changed=False, backup=True):
        metadata = dict(self._local.metadata)
        months = set(metadata['months'])
        for name, value in writes.items():
            self._target(name)
            if name.startswith('records/'):
                month = Path(name).stem
                if value is None:
                    months.discard(month)
                else:
                    months.add(month)
        metadata['months'] = sorted(months)
        if records_changed:
            metadata['version'] = uuid.uuid4().hex
        writes = {**writes, 'metadata.json': metadata}
        transaction = {'format': 1, 'id': uuid.uuid4().hex, 'writes': writes, 'checksum': checksum(writes)}
        journal = self.root / 'transactions' / 'pending.json'
        atomic_json(journal, transaction)
        self._apply_transaction(transaction)
        journal.unlink()
        sync_directory(journal.parent)
        self._local.metadata = metadata
        if backup:
            self._maybe_backup()

    def _shard_name(self, record):
        return f'records/{month_key(record_time(record))}.json'

    def _group_records(self, records):
        grouped = {}
        for record in records:
            grouped.setdefault(self._shard_name(record), []).append(record)
        return grouped

    def _read_month(self, month):
        records = self._read_json(self.root / 'records' / f'{month}.json')
        try:
            validate_records(records)
            if any(self._shard_name(record) != f'records/{month}.json' for record in records):
                raise StorageValidationError('Record is stored in the wrong month')
        except StorageValidationError as exc:
            raise StorageError(f'Invalid shard {month}: {exc}') from exc
        return records

    def version(self):
        with self.locked():
            return self._local.metadata['version']

    def read_records(self, start=None, end=None, date_prefix=None):
        with self.locked():
            if start is not None and start.tzinfo is None:
                start = start.replace(tzinfo=CN_TZ)
            if end is not None and end.tzinfo is None:
                end = end.replace(tzinfo=CN_TZ)
            if not date_prefix and start is not None and end is not None and start >= end:
                return []
            lower, upper = start, end
            if date_prefix:
                try:
                    day = datetime.strptime(date_prefix, '%Y-%m-%d').replace(tzinfo=CN_TZ)
                    lower, upper = day - timedelta(days=2), day + timedelta(days=3)
                except (ValueError, OverflowError):
                    lower, upper = None, None
            first_month = month_key(lower) if lower else None
            last_month = None
            if upper is not None:
                try:
                    last_month = month_key(upper.astimezone(CN_TZ) - timedelta(microseconds=1))
                except OverflowError:
                    return []
            records = []
            for month in self._local.metadata['months']:
                if (first_month and month < first_month) or (last_month and month > last_month):
                    continue
                records.extend(self._read_month(month))
            if date_prefix:
                return [record for record in records if record['time'].startswith(date_prefix)]
            if start or end:
                records = [record for record in records if
                           (start is None or record_time(record) >= start)
                           and (end is None or record_time(record) < end)]
            return records

    def _find(self, identifier):
        for month in reversed(self._local.metadata['months']):
            records = self._read_month(month)
            for position, record in enumerate(records):
                if record['id'] == identifier:
                    return month, records, position
        return None

    def get_record(self, identifier):
        with self.locked():
            found = self._find(identifier)
            return found[1][found[2]] if found else None

    def insert_record(self, record):
        validate_records([record])
        with self.locked():
            if self._find(record['id']):
                raise StorageValidationError('Record id already exists')
            month = month_key(record_time(record))
            records = self._read_month(month) if month in self._local.metadata['months'] else []
            records.append(record)
            self._commit({f'records/{month}.json': records}, records_changed=True)

    def update_record(self, record):
        validate_records([record])
        with self.locked():
            found = self._find(record['id'])
            if found is None:
                raise StorageValidationError('Record not found')
            old_month, old_records, position = found
            new_month = month_key(record_time(record))
            if old_month == new_month:
                old_records[position] = record
                writes = {f'records/{old_month}.json': old_records}
            else:
                old_records.pop(position)
                new_records = self._read_month(new_month) if new_month in self._local.metadata['months'] else []
                new_records.append(record)
                writes = {f'records/{old_month}.json': old_records or None, f'records/{new_month}.json': new_records}
            self._commit(writes, records_changed=True)

    def delete_record(self, identifier):
        with self.locked():
            found = self._find(identifier)
            if found is None:
                return False
            month, records, position = found
            records.pop(position)
            self._commit({f'records/{month}.json': records or None}, records_changed=True)
            return True

    def read_setting(self, name, default=None):
        self._validate_setting(name, None)
        with self.locked():
            path = self.root / name
            if not path.exists():
                return default
            value = self._read_json(path)
            try:
                self._validate_setting(name, value)
            except StorageValidationError as exc:
                raise StorageError(str(exc)) from exc
            if value is None:
                raise StorageError(f'{name} must not contain null')
            return value

    def write_setting(self, name, value):
        self._validate_setting(name, value)
        with self.locked():
            self._commit({name: value})

    def _settings_snapshot(self):
        settings = {}
        for name in SETTING_FILES:
            path = self.root / name
            value = self._read_json(path) if path.exists() else None
            if path.exists() and value is None:
                raise StorageValidationError(f'{name} must not contain null')
            self._validate_setting(name, value)
            settings[name] = value
        return settings

    def _write_backup(self, kind='snapshot', records=None, settings=None):
        if records is None:
            records = self.read_records()
        validate_records(records)
        if settings is None:
            settings = self._settings_snapshot()
        created = datetime.now(CN_TZ)
        filename = f'{kind}_{created:%Y%m%d_%H%M%S_%f}_{uuid.uuid4().hex[:8]}.json'
        payload = {'records': records, 'settings': settings}
        snapshot = {'format': 'baby-json-backup-v1', 'createdAt': created.isoformat(), **payload, 'checksum': checksum(payload)}
        atomic_json(self.root / 'backups' / filename, snapshot)
        logger.info('Created %s backup: %s (%d records)', kind, filename, len(records))
        return filename

    def _maybe_backup(self):
        try:
            snapshots = list((self.root / 'backups').glob('snapshot_*.json'))
            latest = max((path.stat().st_mtime for path in snapshots), default=0)
            if datetime.now(CN_TZ).timestamp() - latest >= self.backup_interval:
                self._write_backup()
                self._prune_backups()
        except (OSError, StorageError, ValueError, TypeError) as exc:
            logger.warning('Data committed, but automatic backup failed: %s', exc)

    def _prune_backups(self):
        now = datetime.now(CN_TZ)
        days, weeks = set(), set()
        snapshots = sorted((self.root / 'backups').glob('snapshot_*.json'), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in snapshots:
            modified = datetime.fromtimestamp(path.stat().st_mtime, CN_TZ)
            age = now - modified
            day = modified.date()
            week = modified.isocalendar()[:2]
            keep = age <= timedelta(days=1)
            if age <= timedelta(days=14) and day not in days:
                days.add(day)
                keep = True
            if age <= timedelta(weeks=8) and week not in weeks:
                weeks.add(week)
                keep = True
            if not keep:
                path.unlink()
        sync_directory(self.root / 'backups')

    def backup(self):
        with self.locked():
            filename = self._write_backup()
            self._prune_backups()
            return filename

    def list_backups(self):
        with self.locked():
            paths = [path for path in (self.root / 'backups').iterdir()
                     if BACKUP_PATTERN.fullmatch(path.name) and path.is_file() and not path.is_symlink()]
            return [{'filename': path.name, 'size': path.stat().st_size,
                     'time': datetime.fromtimestamp(path.stat().st_mtime).isoformat()}
                    for path in sorted(paths, key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True)]

    def restore(self, filename=None):
        with self.locked():
            if filename is None:
                candidates = [item for item in self.list_backups() if not item['filename'].startswith('before_restore_')]
                if not candidates:
                    raise BackupNotFoundError('No backups found')
                filename = candidates[0]['filename']
            if not isinstance(filename, str) or not BACKUP_PATTERN.fullmatch(filename):
                raise StorageValidationError('Invalid backup filename')
            path = self.root / 'backups' / filename
            if path.is_symlink():
                raise StorageValidationError('Backup must not be a symlink')
            if not path.is_file():
                raise BackupNotFoundError('Backup not found')
            try:
                contents = self._read_json(path)
            except StorageError as exc:
                raise StorageValidationError(f'Cannot read backup: {exc}') from exc
            settings = {}
            if isinstance(contents, list):
                records = contents
            elif isinstance(contents, dict) and contents.get('format') == 'baby-json-backup-v1':
                records, settings = contents.get('records'), contents.get('settings')
                if not isinstance(settings, dict) or set(settings) != set(SETTING_FILES):
                    raise StorageValidationError('Backup settings are incomplete')
                if checksum({'records': records, 'settings': settings}) != contents.get('checksum'):
                    raise StorageValidationError('Backup checksum mismatch')
                for name, value in settings.items():
                    self._validate_setting(name, value)
            else:
                raise StorageValidationError('Unknown backup format')
            validate_records(records)
            self._write_backup('before_restore')
            writes = {f'records/{month}.json': None for month in self._local.metadata['months']}
            writes.update(self._group_records(records))
            writes.update(settings)
            self._commit(writes, records_changed=True, backup=False)
            logger.warning('Restored backup %s: %d records', filename, len(records))
            return {'success': True, 'count': len(records), 'file': filename}

    def verify(self):
        with self.locked():
            records = self.read_records()
            validate_records(records)
            self._settings_snapshot()
            expected = {f'{month}.json' for month in self._local.metadata['months']}
            actual = {path.name for path in (self.root / 'records').glob('*.json')}
            if expected != actual:
                raise StorageError('Monthly files do not match the storage metadata')
            return {'count': len(records), 'months': self._local.metadata['months'], 'version': self.version()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('migrate', 'verify', 'backup', 'restore', 'export'))
    parser.add_argument('--data-dir', default=os.getenv('BABY_DATA_DIR', str(Path(__file__).parent / 'data')))
    parser.add_argument('--output', help='Export destination outside the live data directory')
    parser.add_argument('--filename', help='Backup filename for restore; defaults to the latest backup')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    store = JsonRecordStore(args.data_dir)
    try:
        if args.command in ('migrate', 'verify'):
            result = store.verify()
        elif args.command == 'backup':
            result = {'filename': store.backup()}
        elif args.command == 'restore':
            result = store.restore(args.filename)
        else:
            if not args.output:
                parser.error('export requires --output')
            output = Path(args.output).resolve()
            if output == store.root or store.root in output.parents:
                parser.error('export must not overwrite files inside the live data directory')
            records = store.read_records()
            atomic_json(output, records)
            result = {'count': len(records), 'output': str(output)}
        print(json.dumps(result, ensure_ascii=False))
    except (StorageError, StorageValidationError, BackupNotFoundError, OSError, ValueError) as exc:
        parser.exit(1, f'Storage operation failed: {exc}\n')


if __name__ == '__main__':
    main()
