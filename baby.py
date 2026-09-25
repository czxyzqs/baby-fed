#!/usr/bin/env python3
"""Baby Tracking Web Service - Flask Backend"""

import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from functools import lru_cache, wraps
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from flask import Flask, render_template, request, jsonify, make_response
from flask_compress import Compress
from food_library import register_food_library
from food_entries import register_food_entries
from food_screening import register_food_screening
from storage import BackupNotFoundError, JsonRecordStore, StorageError, StorageValidationError
from storage import record_time as stored_record_time

MINIMAX_API_KEY = os.getenv('MINIMAX_API_KEY', '')
MINIMAX_BASE_URL = 'https://api.minimaxi.com/v1/chat/completions'
BUILD_ID = '2026-06-02 13:20 +0800'


app = Flask(__name__)
app.config.update(
    COMPRESS_ALGORITHM=['gzip'],
    COMPRESS_LEVEL=6,
    COMPRESS_MIN_SIZE=500,
    COMPRESS_STREAMS=False,
    COMPRESS_REGISTER=False,
)
compressor = Compress(app)
STATIC_ASSET_VERSIONS = {
    asset_path.relative_to(app.static_folder).as_posix(): hashlib.sha256(asset_path.read_bytes()).hexdigest()[:16]
    for asset_path in Path(app.static_folder).rglob('*')
    if asset_path.is_file() and asset_path.suffix in ('.css', '.js')
}


@app.url_defaults
def add_static_asset_version(endpoint, values):
    if endpoint == 'static':
        version = STATIC_ASSET_VERSIONS.get(values.get('filename'))
        if version:
            values.setdefault('v', version)


@app.after_request
def optimize_response(response):
    if request.endpoint == 'static':
        filename = (request.view_args or {}).get('filename')
        version = STATIC_ASSET_VERSIONS.get(filename)
        if version and request.args.get('v') == version and response.status_code in (200, 304):
            response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        else:
            response.headers['Cache-Control'] = 'no-cache'
    elif response.mimetype in ('text/html', 'application/json'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'

    if response.mimetype not in compressor.compress_mimetypes_set:
        return response
    response.vary.add('Accept-Encoding')
    if (
        response.status_code != 200
        or request.method not in ('GET', 'HEAD')
        or request.accept_encodings['gzip'] <= 0
        or response.cache_control.no_transform
        or 'Content-Encoding' in response.headers
    ):
        return response
    if request.endpoint == 'static':
        response.direct_passthrough = False
        response.set_data(response.get_data())
    return compressor.after_request(response)


@app.route('/test')
def test_version():
    return f'SERVER V2 | BUILD {BUILD_ID} | ' + now_cn_naive().isoformat()


@app.after_request
def add_build_header(response):
    response.headers['X-Build-Id'] = BUILD_ID
    return response


@app.before_request
def method_override():
    """Support form-based _method override for iframe requests."""
    if request.method == 'POST' and request.form.get('_method'):
        request.environ['REQUEST_METHOD'] = request.form['_method'].upper()


def request_data():
    """Get JSON data from request body (JSON or form-encoded _json field)."""
    if request.is_json:
        return request.get_json()
    raw = request.form.get('_json')
    if raw:
        return json.loads(raw)
    return None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.getenv('BABY_DATA_DIR', os.path.join(BASE_DIR, 'data'))
record_store = JsonRecordStore(DATA_DIR)
register_food_library(app, DATA_DIR)
register_food_entries(app, DATA_DIR)
register_food_screening(app, DATA_DIR)
BABY_BIRTH_DATE = '2026-03-08'  # 宝宝出生日期
CN_TZ = timezone(timedelta(hours=8))
REMINDER_POLL_SECONDS = int(os.getenv('REMINDER_POLL_SECONDS', '30'))
MAX_DAILY_SUPPLEMENT_DOSES = 4
XIAOAI_BASE_URL = os.getenv('XIAOAI_BASE_URL', 'http://192.168.60.142:9092').strip().rstrip('/')
XIAOAI_TIMEOUT_MS = int(os.getenv('XIAOAI_TIMEOUT_MS', '60000'))
XIAOAI_BLOCKING = os.getenv('XIAOAI_BLOCKING', 'false').strip().lower() in ('1', 'true', 'yes', 'on')
_reminder_thread_lock = threading.Lock()
_reminder_thread_started = False


def now_cn_naive():
    """Current China time without timezone suffix (local wall-clock)."""
    return datetime.now(CN_TZ).replace(tzinfo=None)


def now_cn():
    """Current China time with timezone info."""
    return datetime.now(CN_TZ)


def is_quiet_hours(dt):
    """Return True during 21:00-08:00 quiet hours."""
    local_dt = dt.astimezone(CN_TZ) if dt.tzinfo else dt.replace(tzinfo=CN_TZ)
    return local_dt.hour >= 21 or local_dt.hour < 8


def ensure_data_file():
    """Initialize or recover the monthly JSON store."""
    with record_store.locked():
        pass


def load_records(start=None, end=None, date_prefix=None):
    """Read only the months needed by an optional date range."""
    return record_store.read_records(start=start, end=end, date_prefix=date_prefix)


def records_file_version():
    """Return the version of the last committed record transaction."""
    return record_store.version()


def storage_transaction(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        with record_store.locked():
            return handler(*args, **kwargs)
    return wrapped


@app.errorhandler(StorageError)
def storage_unavailable(error):
    app.logger.error('Storage unavailable: %s', error)
    response = jsonify({'success': False, 'error': '记录存储暂不可用，请检查服务日志或备份'})
    response.status_code = 503
    response.headers['Retry-After'] = '1'
    return response


@app.errorhandler(StorageValidationError)
def invalid_storage_input(error):
    return jsonify({'success': False, 'error': str(error)}), 400


def parse_record_time(value):
    """Parse record time to China timezone aware datetime."""
    if not value:
        return None
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        return dt.replace(tzinfo=CN_TZ)
    return dt.astimezone(CN_TZ)


def format_cn_time(dt):
    """Format China timezone datetime as HH:MM."""
    return dt.astimezone(CN_TZ).strftime('%H:%M')


def find_latest_record(records, predicate):
    """Return latest matching record by parsed time."""
    latest = None
    latest_time = None
    for record in records:
        if not predicate(record):
            continue
        try:
            record_time = parse_record_time(record.get('time'))
        except (TypeError, ValueError):
            continue
        if latest_time is None or record_time > latest_time:
            latest = record
            latest_time = record_time
    return latest, latest_time


def build_feed_reminders(record, record_time, now_time):
    """Build due feed reminders for the latest new milk record."""
    elapsed = now_time - record_time
    half_hour_mark = timedelta(hours=3, minutes=30)
    reminders = []
    milestones = [
        ('after_1h', timedelta(hours=1), '喂奶提醒', f'距离下次喝奶还有 2 小时，上次新奶时间 {format_cn_time(record_time)}。'),
        ('after_2h', timedelta(hours=2), '喂奶提醒', f'距离下次喝奶还有 1 小时，上次新奶时间 {format_cn_time(record_time)}。'),
        ('due_3h', timedelta(hours=3), '该喝奶啦', f'距离上次新奶已经 3 小时，上次新奶时间 {format_cn_time(record_time)}。'),
    ]

    for milestone, offset, summary, content in milestones:
        if elapsed >= offset:
            reminders.append((milestone, summary, content))

    if elapsed >= half_hour_mark:
        extra_hours = int((elapsed - half_hour_mark).total_seconds() // 3600)
        overdue_index = extra_hours + 1
        total_hours = 3.5 + extra_hours
        hour_text = f'{int(total_hours)}小时30分钟' if total_hours % 1 else f'{int(total_hours)}小时'
        reminders.append((
            f'overdue_{overdue_index}',
            '该喝奶啦',
            f'距离上次新奶已经 {hour_text}，仍未录入新的新奶记录，请尽快喂奶。上次新奶时间 {format_cn_time(record_time)}。'
        ))

    return reminders


def build_diaper_reminders(record, record_time, now_time):
    """Build due diaper reminders for the latest diaper record."""
    elapsed = now_time - record_time
    reminders = []
    milestones = [
        ('after_1h', timedelta(hours=1), '尿不湿提醒', f'距离下次换尿不湿还有 1 小时，上次更换时间 {format_cn_time(record_time)}。'),
        ('due_2h', timedelta(hours=2), '该换尿不湿啦', f'距离上次更换尿不湿已经 2 小时，上次更换时间 {format_cn_time(record_time)}。'),
    ]

    for milestone, offset, summary, content in milestones:
        if elapsed >= offset:
            reminders.append((milestone, summary, content))

    if elapsed >= timedelta(hours=3):
        extra_hours = int((elapsed - timedelta(hours=3)).total_seconds() // 3600)
        overdue_index = extra_hours + 1
        total_hours = 3 + extra_hours
        reminders.append((
            f'overdue_{overdue_index}',
            '该换尿不湿啦',
            f'距离上次更换尿不湿已经 {total_hours} 小时，仍未录入新的尿不湿记录，请尽快更换。上次更换时间 {format_cn_time(record_time)}。'
        ))

    return reminders


def normalize_intake_plan(plan):
    """Normalize the independent daily-dose and reminder settings for a supplement."""
    plan = plan if isinstance(plan, dict) else {}
    try:
        daily_count = int(plan.get('dailyCount') or 1)
    except (TypeError, ValueError):
        daily_count = 1
    daily_count = max(1, min(MAX_DAILY_SUPPLEMENT_DOSES, daily_count))

    reminder_mode = plan.get('reminderMode') or 'checklist'
    if reminder_mode not in ('none', 'checklist', 'timed'):
        reminder_mode = 'checklist'

    slots = []
    used_ids = set()
    for index, slot in enumerate(plan.get('slots') or []):
        if not isinstance(slot, dict):
            continue
        time_value = str(slot.get('time') or '').strip()
        if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', time_value):
            continue
        slot_id = str(slot.get('id') or f'slot_{index + 1}').strip()
        if not slot_id or slot_id in used_ids:
            slot_id = f'slot_{index + 1}'
        if slot_id in used_ids:
            continue
        used_ids.add(slot_id)
        label = str(slot.get('label') or '').strip() or f'第{len(slots) + 1}次'
        slots.append({'id': slot_id, 'label': label, 'time': time_value})

    # Timed reminders only make sense when every required daily dose has a time.
    if reminder_mode == 'timed' and len(slots) != daily_count:
        reminder_mode = 'checklist'
        slots = []
    elif reminder_mode != 'timed':
        slots = []

    return {
        'dailyCount': daily_count,
        'reminderMode': reminder_mode,
        'slots': slots,
    }


def claim_reminder_event(event_key, meta):
    """Persistently claim a reminder event to avoid duplicate sends."""
    with record_store.locked():
        state = record_store.read_setting('reminder_state.json', {'sent': {}})
        sent = state.setdefault('sent', {})
        cutoff = (now_cn() - timedelta(days=7)).isoformat()
        sent = {
            key: value for key, value in sent.items()
            if value.get('claimedAt', '') >= cutoff
        }
        state['sent'] = sent
        if event_key in sent:
            return False
        sent[event_key] = meta
        record_store.write_setting('reminder_state.json', state)
        return True


def release_reminder_event(event_key):
    """Release a claimed event so the next loop can retry after send failure."""
    with record_store.locked():
        state = record_store.read_setting('reminder_state.json', {'sent': {}})
        sent = state.setdefault('sent', {})
        if event_key in sent:
            sent.pop(event_key, None)
            record_store.write_setting('reminder_state.json', state)


def send_xiaoai_message(summary, content):
    """Send a reminder via XiaoAi HTTP API."""
    if not XIAOAI_BASE_URL:
        sys.stderr.write('[reminder] skip send: XIAOAI_BASE_URL not configured\n')
        sys.stderr.flush()
        return False
    if is_quiet_hours(now_cn()):
        sys.stderr.write('[reminder] quiet hours active, skip xiaoai broadcast\n')
        sys.stderr.flush()
        return True

    text = f'{summary}。{content}'
    payload = {
        'text': text,
        'blocking': XIAOAI_BLOCKING,
        'timeout': XIAOAI_TIMEOUT_MS,
    }
    req = urllib.request.Request(
        f'{XIAOAI_BASE_URL}/api/play/text',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json; charset=utf-8'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        success = bool(result.get('success'))
        if not success:
            sys.stderr.write(f'[reminder] XiaoAi send failed: {result}\n')
            sys.stderr.flush()
        return bool(success)
    except Exception as exc:
        sys.stderr.write(f'[reminder] XiaoAi request error: {exc}\n')
        sys.stderr.flush()
        return False


def build_supplement_reminders(settings, records, now_time):
    """Build one due reminder per unfinished timed supplement slot."""
    date = now_time.astimezone(CN_TZ).strftime('%Y-%m-%d')
    for item in get_due_supplement_instances(settings, records, date):
        if item['reminderMode'] != 'timed' or item['taken'] or not item['time']:
            continue
        scheduled_time = datetime.strptime(
            f"{date} {item['time']}", '%Y-%m-%d %H:%M'
        ).replace(tzinfo=CN_TZ)
        if now_time < scheduled_time:
            continue
        yield item, (
            '补剂提醒',
            f"{item['name']} {item['slotLabel']}该服用了，计划时间 {item['time']}。"
        )


def process_due_reminders():
    """Check feed, diaper, and timed supplement reminders."""
    with record_store.locked():
        records = load_records()
        settings = load_supplement_settings()
    now_time = now_cn()
    latest_feed, latest_feed_time = find_latest_record(
        records,
        lambda item: item.get('type') == 'feed' and item.get('isNewMilk') is True
    )
    latest_diaper, latest_diaper_time = find_latest_record(
        records,
        lambda item: item.get('type') == 'diaper'
    )

    due_reminders = []
    if latest_feed and latest_feed_time:
        due_reminders.extend(
            ('feed', latest_feed, latest_feed_time, milestone, summary, content)
            for milestone, summary, content in build_feed_reminders(latest_feed, latest_feed_time, now_time)
        )
    if latest_diaper and latest_diaper_time:
        due_reminders.extend(
            ('diaper', latest_diaper, latest_diaper_time, milestone, summary, content)
            for milestone, summary, content in build_diaper_reminders(latest_diaper, latest_diaper_time, now_time)
        )

    due_reminders.extend(
        ('supplement', item, None, 'due', summary, content)
        for item, (summary, content) in build_supplement_reminders(settings, records, now_time)
    )

    for kind, record, record_time, milestone, summary, content in due_reminders:
        if kind == 'supplement':
            event_key = f"supplement:{now_time.strftime('%Y-%m-%d')}:{record['supplementId']}:{record['doseSlotId']}:{milestone}"
            metadata = {
                'type': kind,
                'supplementId': record['supplementId'],
                'doseSlotId': record['doseSlotId'],
                'milestone': milestone,
                'claimedAt': now_time.isoformat(),
            }
        else:
            event_key = f"{kind}:{record.get('id')}:{record.get('time')}:{milestone}"
            metadata = {
                'type': kind,
                'recordId': record.get('id'),
                'recordTime': record.get('time'),
                'milestone': milestone,
                'claimedAt': now_time.isoformat(),
            }
        claimed = claim_reminder_event(event_key, {
            **metadata,
        })
        if not claimed:
            continue
        if not send_xiaoai_message(summary, content):
            release_reminder_event(event_key)


def reminder_loop():
    """Background reminder loop."""
    while True:
        try:
            process_due_reminders()
        except Exception as exc:
            sys.stderr.write(f'[reminder] loop error: {exc}\n')
            sys.stderr.flush()
        time.sleep(max(10, REMINDER_POLL_SECONDS))


def start_reminder_scheduler():
    """Start the background reminder scheduler once per process."""
    global _reminder_thread_started
    if os.getenv('REMINDER_ENABLED', 'true').lower() in ('0', 'false', 'no', 'off'):
        return
    with _reminder_thread_lock:
        if _reminder_thread_started:
            return
        ensure_data_file()
        thread = threading.Thread(target=reminder_loop, name='reminder-loop', daemon=True)
        thread.start()
        _reminder_thread_started = True


def load_supplement_settings():
    """Load supplement settings from JSON file."""
    return record_store.read_setting('supplement_settings.json', get_default_supplement_settings())

def save_supplement_settings(settings):
    """Save supplement settings to JSON file."""
    settings = normalize_supplement_settings(settings)
    record_store.write_setting('supplement_settings.json', settings)

def get_default_supplement_settings():
    """Return default supplement settings."""
    return {
        "supplements": [
            {"id": "D3", "name": "D3", "icon": "☀️", "frequencyType": "everyNDays", "intervalDays": 1, "startDate": "2026-05-27"},
            {"id": "AD", "name": "AD", "icon": "🌟", "frequencyType": "alternating", "groupId": "vitamins", "groupName": "维生素交替组", "alternatingOrder": 1, "startDate": "2026-05-27"},
            {"id": "probiotic", "name": "益生菌", "icon": "🫙", "frequencyType": "everyNDays", "intervalDays": 2, "startDate": "2026-05-27"},
            {"id": "iron", "name": "铁", "icon": "🔩", "frequencyType": "everyNDays", "intervalDays": 2, "startDate": "2026-05-27"}
        ],
        "alternatingGroups": [
            {
                "id": "vitamins",
                "name": "维生素交替组",
                "members": ["D3", "AD"],
                "startDate": "2026-05-27",
                "startIndex": 0
            }
        ]
    }


def load_medicine_settings():
    """Load the configurable medicine list used by health records."""
    return normalize_medicine_settings(record_store.read_setting('medicine_settings.json', {'medicines': []}))


def normalize_medicine_settings(settings):
    medicines = settings.get('medicines') if isinstance(settings, dict) else []
    normalized = []
    seen = set()
    for medicine in medicines or []:
        name = str(medicine).strip()
        if name and name not in seen:
            normalized.append(name)
            seen.add(name)
    return {'medicines': normalized}


def save_medicine_settings(settings):
    """Save the configurable medicine list."""
    normalized = normalize_medicine_settings(settings)
    record_store.write_setting('medicine_settings.json', normalized)
    return normalized


def load_fever_mode():
    settings = record_store.read_setting('fever_mode.json', {'enabled': False})
    return {'enabled': isinstance(settings, dict) and settings.get('enabled') is True}


def save_fever_mode(enabled):
    record_store.write_setting('fever_mode.json', {'enabled': enabled})


def get_supplement_record_type(supp):
    """Map supplement settings or names to record supplementType values when possible."""
    if isinstance(supp, dict):
        candidates = [supp.get('id'), supp.get('name')]
    else:
        candidates = [supp]

    for candidate in candidates:
        # Settings may use a descriptive name (for example "绿AD"), while
        # records created before configurable supplements used D3/AD directly.
        # Compare the ASCII identifier embedded in the name for compatibility.
        raw_value = (candidate or '').strip().lower()
        value = ''.join(re.findall(r'[a-z0-9]+', raw_value))
        if value == 'd3':
            return 'D3'
        if value == 'ad':
            return 'AD'
        if value == 'iron' or raw_value == '铁':
            return 'iron'
        if value == 'probiotic' or raw_value == '益生菌':
            return 'probiotic'
    return None


def get_supplement_display(supplement_type):
    """Return the configured display data for a supplement record type."""
    settings = load_supplement_settings()
    supplements = settings.get('supplements', [])
    configured = next((s for s in supplements if s.get('id') == supplement_type), None)
    if configured is None:
        # Keep old D3/AD/iron/probiotic records meaningful after users rename
        # a configured supplement.
        configured = next(
            (s for s in supplements if get_supplement_record_type(s) == supplement_type),
            None
        )
    if configured:
        return configured.get('icon') or '💊', configured['name']

    legacy_labels = {
        'D3': ('☀️', 'D3'),
        'AD': ('🌟', 'AD'),
        'iron': ('🔩', '铁'),
        'probiotic': ('🫙', '益生菌'),
    }
    return legacy_labels.get(supplement_type, ('💊', supplement_type))


def set_supplement_record_fields(record, supplement_type):
    """Set a supplement record's stable type and its configured label."""
    icon, name = get_supplement_display(supplement_type)
    record['supplementType'] = supplement_type
    record['label'] = f'{icon} {name}'
    record['detail'] = record['label']


def normalize_supplement_settings(settings):
    """Normalize supplement settings for storage and calculation."""
    settings = settings or {}
    supplements = settings.get('supplements') or []
    normalized = []

    for idx, supp in enumerate(supplements):
        name = (supp.get('name') or '').strip()
        if not name:
            continue
        supp_id = supp.get('id') or re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_') or f'supp_{idx}'
        freq_type = supp.get('frequencyType') or 'everyNDays'
        item = {
            'id': supp_id,
            'name': name,
            'icon': supp.get('icon') or '💊',
            'enabled': supp.get('enabled') is not False,
            'frequencyType': freq_type,
            # Old settings intentionally become a one-dose daily checklist,
            # preserving their existing homepage reminder behaviour.
            'intakePlan': normalize_intake_plan(supp.get('intakePlan')),
        }

        if freq_type == 'daily':
            item['frequencyType'] = 'everyNDays'
            item['intervalDays'] = 1
            item['startDate'] = supp.get('startDate') or now_cn_naive().strftime('%Y-%m-%d')
        elif freq_type == 'everyOtherDay':
            item['frequencyType'] = 'everyNDays'
            item['intervalDays'] = 2
            item['startDate'] = supp.get('startDate') or now_cn_naive().strftime('%Y-%m-%d')
        elif item['frequencyType'] == 'everyNDays':
            item['intervalDays'] = max(1, int(supp.get('intervalDays') or 1))
            item['startDate'] = supp.get('startDate') or now_cn_naive().strftime('%Y-%m-%d')
        elif item['frequencyType'] == 'weeklyTimes':
            custom_days = supp.get('customDays') or []
            custom_days = sorted({
                int(day) for day in custom_days
                if str(day).isdigit() and 0 <= int(day) <= 6
            })
            if custom_days:
                item['customDays'] = custom_days
                item['timesPerWeek'] = len(custom_days)
            else:
                item['timesPerWeek'] = min(7, max(1, int(supp.get('timesPerWeek') or 1)))
            item['startDate'] = supp.get('startDate') or now_cn_naive().strftime('%Y-%m-%d')
        elif item['frequencyType'] == 'alternating':
            item['groupId'] = (supp.get('groupId') or 'alternating').strip() or 'alternating'
            item['groupName'] = (supp.get('groupName') or '').strip()
            item['alternatingOrder'] = int(supp.get('alternatingOrder') or 0)
            item['startDate'] = supp.get('startDate') or now_cn_naive().strftime('%Y-%m-%d')
        else:
            item['frequencyType'] = 'everyNDays'
            item['intervalDays'] = 1
            item['startDate'] = supp.get('startDate') or now_cn_naive().strftime('%Y-%m-%d')

        normalized.append(item)

    alternating_groups = []
    groups = {}
    for supp in normalized:
        if supp.get('frequencyType') != 'alternating':
            continue
        group_id = supp['groupId']
        groups.setdefault(group_id, {
            'id': group_id,
            'name': supp.get('groupName') or '',
            'startDate': supp.get('startDate') or now_cn_naive().strftime('%Y-%m-%d'),
            'members': []
        })
        groups[group_id]['members'].append((supp.get('alternatingOrder', 0), supp['id']))

    for group in groups.values():
        members = [supp_id for _, supp_id in sorted(group['members'], key=lambda x: (x[0], x[1]))]
        alternating_groups.append({
            'id': group['id'],
            'name': group['name'],
            'members': members,
            'startDate': group['startDate'],
            'startIndex': 0
        })

    return {
        'supplements': normalized,
        'alternatingGroups': alternating_groups
    }


def build_dashboard_data(records, settings, now):
    if now.tzinfo is None:
        now = now.replace(tzinfo=CN_TZ)
    else:
        now = now.astimezone(CN_TZ)
    today = now.date()
    health_cutoff = now - timedelta(hours=72)
    timed_records = []
    for record in records:
        try:
            record_time = parse_record_time(record.get('time'))
        except (AttributeError, TypeError, ValueError):
            record_time = None
        timed_records.append((record, record_time))
    timed_records.sort(key=lambda item: item[1] or datetime.min.replace(tzinfo=CN_TZ))

    durations = {'left': 0, 'right': 0}
    open_sleep = None
    for record, record_time in timed_records:
        if record.get('type') != 'sleep' or record_time is None:
            continue
        if record.get('sleepType') == 'sleep':
            open_sleep = (record, record_time)
        elif record.get('sleepType') == 'awake' and open_sleep:
            position = open_sleep[0].get('sleepPosition')
            if position in durations:
                durations[position] += max(0, (record_time - open_sleep[1]).total_seconds())
            open_sleep = None
    if open_sleep:
        position = open_sleep[0].get('sleepPosition')
        if position in durations:
            durations[position] += max(0, (now - open_sleep[1]).total_seconds())
    recommended_position = min(durations, key=durations.get) if sum(durations.values()) > 0 else None

    dashboard_records = []
    type_counts = {}
    latest_states = set()
    for index, (record, record_time) in enumerate(reversed(timed_records)):
        record_type = record.get('type')
        type_counts[record_type] = type_counts.get(record_type, 0) + 1
        state_key = None
        if record_type == 'feed' and record.get('isNewMilk'):
            state_key = 'newMilk'
        elif record_type == 'sleep' and record.get('sleepType') == 'awake':
            state_key = 'awake'
        needed_state = state_key is not None and state_key not in latest_states
        if state_key is not None:
            latest_states.add(state_key)
        is_today = record_time is not None and record_time.date() == today
        recent_health = record_type == 'health' and record_time is not None and record_time >= health_cutoff
        if index < 10 or type_counts[record_type] <= 10 or needed_state or is_today or recent_health:
            dashboard_records.append(record)

    return {
        'records': dashboard_records,
        'dueSupplements': get_due_supplement_instances(settings, records, today.isoformat()),
        'recommendedSleepPosition': recommended_position,
    }


@app.route('/api/dashboard', methods=['GET'])
@storage_transaction
def get_dashboard():
    dashboard = build_dashboard_data(load_records(), load_supplement_settings(), now_cn())
    dashboard['feverMode'] = load_fever_mode()
    response = make_response(jsonify(dashboard))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['X-Records-Version'] = records_file_version()
    return response


@app.route('/food-library')
def food_library_page():
    return render_template('food-library.html')


@app.route('/food-history')
def food_history_page():
    return render_template('food-history.html')


@app.route('/screening')
def screening_page():
    return render_template('screening.html')


@app.route('/planning')
def planning_page():
    return render_template('planning.html')


@app.route('/')
@storage_transaction
def index():
    now = now_cn_naive()

    # 补剂提醒：根据设置动态计算
    today = now.strftime('%Y-%m-%d')
    settings = load_supplement_settings()
    records = load_records()
    dashboard = build_dashboard_data(records, settings, now)

    # 计算今日统计
    today_records = [r for r in records if r.get('time', '').startswith(today)]
    recent_health_cutoff = now - timedelta(hours=72)
    has_recent_health_records = False
    for record in records:
        if record.get('type') != 'health':
            continue
        try:
            recorded_at = datetime.fromisoformat(record.get('time', '').replace('Z', '+00:00'))
            if recorded_at.tzinfo is not None:
                recorded_at = recorded_at.astimezone(CN_TZ).replace(tzinfo=None)
            if recorded_at >= recent_health_cutoff:
                has_recent_health_records = True
                break
        except (TypeError, ValueError):
            continue
    diaper_count = len([r for r in today_records if r.get('type') == 'diaper'])
    feed_count = len([r for r in today_records if r.get('type') == 'feed'])
    tummy_minutes = 0
    for r in today_records:
        if r.get('type') != 'tummy':
            continue
        try:
            tummy_minutes += max(0, int(r.get('duration') or 0))
        except (TypeError, ValueError):
            pass
    today_due_supplements = dashboard['dueSupplements']
    supplement_taken = sum(1 for item in today_due_supplements if item['taken'])
    supplement_reminder_items = get_supplement_progress_items(today_due_supplements)

    supplement_needed = len(today_due_supplements)
    show_supplement_reminder = len(supplement_reminder_items) > 0

    # 传递记录数据到模板（避免前端 fetch）
    records_json = json.dumps(dashboard['records'], ensure_ascii=False)
    due_supplements_json = json.dumps(today_due_supplements, ensure_ascii=False)

    cache_bust = now.strftime('%Y%m%d%H%M%S')
    response = make_response(render_template('index.html',
        show_supplement_reminder=show_supplement_reminder,
        supplement_reminder_items=supplement_reminder_items,
        cache_bust=cache_bust,
        init_records=records_json,
        init_due_supplements=due_supplements_json,
        init_recommended_sleep_position=dashboard['recommendedSleepPosition'],
        fever_mode=load_fever_mode(),
        supplement_options=[{
            **supp,
            'legacyRecordType': get_supplement_record_type(supp) or ''
        } for supp in settings.get('supplements', [])],
        diaper_count=diaper_count,
        feed_count=feed_count,
        has_recent_health_records=has_recent_health_records,
        tummy_minutes=tummy_minutes,
        supplement_taken=supplement_taken,
        supplement_needed=supplement_needed))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


@app.route('/api/supplement-settings', methods=['GET'])
def get_supplement_settings():
    """Get supplement settings."""
    settings = load_supplement_settings()
    return jsonify(settings)

@app.route('/api/supplement-settings', methods=['PUT'])
def update_supplement_settings():
    """Update supplement settings."""
    data = request_data()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    for supplement in data.get('supplements') or []:
        if 'enabled' in supplement and not isinstance(supplement['enabled'], bool):
            return jsonify({'error': 'enabled must be a boolean'}), 400
    save_supplement_settings(data)
    return jsonify({'success': True})


@app.route('/api/medicine-settings', methods=['GET'])
def get_medicine_settings():
    """Get the selectable medicine list for health records."""
    return jsonify(load_medicine_settings())


@app.route('/api/medicine-settings', methods=['PUT'])
def update_medicine_settings():
    """Update the selectable medicine list for health records."""
    data = request_data()
    if data is None:
        return jsonify({'error': 'No data provided'}), 400
    save_medicine_settings(data)
    return jsonify({'success': True})

@app.route('/api/fever-mode', methods=['GET', 'PUT'])
def fever_mode_settings():
    if request.method == 'GET':
        return jsonify(load_fever_mode())
    data = request_data()
    if not isinstance(data, dict) or not isinstance(data.get('enabled'), bool):
        return jsonify({'error': 'enabled must be a boolean'}), 400
    save_fever_mode(data['enabled'])
    return jsonify({'enabled': data['enabled']})


def get_today_supplements(settings, date):
    """Calculate which supplements to take today based on settings."""
    result = {}
    date_obj = datetime.strptime(date, '%Y-%m-%d')
    weekday = date_obj.weekday()

    for supp in settings.get('supplements', []):
        if supp.get('enabled') is False:
            result[supp['id']] = False
            continue
        freq_type = supp.get('frequencyType', 'daily')

        if freq_type == 'daily':
            result[supp['id']] = True
        elif freq_type == 'everyOtherDay':
            start_str = supp.get('startDate', date)
            start = datetime.strptime(start_str, '%Y-%m-%d')
            days_diff = (date_obj - start).days
            result[supp['id']] = days_diff % 2 == 0
        elif freq_type == 'everyNDays':
            start_str = supp.get('startDate', date)
            start = datetime.strptime(start_str, '%Y-%m-%d')
            days_diff = (date_obj - start).days
            interval_days = max(1, int(supp.get('intervalDays') or 1))
            result[supp['id']] = days_diff >= 0 and days_diff % interval_days == 0
        elif freq_type == 'weeklyTimes':
            custom_days = supp.get('customDays') or []
            if custom_days:
                result[supp['id']] = weekday in {int(day) for day in custom_days if 0 <= int(day) <= 6}
                continue
            start_str = supp.get('startDate', date)
            start = datetime.strptime(start_str, '%Y-%m-%d')
            days_diff = (date_obj - start).days
            if days_diff < 0:
                result[supp['id']] = False
                continue
            times_per_week = min(7, max(1, int(supp.get('timesPerWeek') or 1)))
            day_in_week = days_diff % 7
            schedule_days = sorted({(i * 7) // times_per_week for i in range(times_per_week)})
            result[supp['id']] = day_in_week in schedule_days
        elif freq_type == 'alternating':
            group_id = supp.get('groupId')
            if not group_id:
                result[supp['id']] = False
                continue
            group = next((g for g in settings.get('alternatingGroups', []) if g['id'] == group_id), None)
            if not group:
                result[supp['id']] = False
                continue
            members = group.get('members', [])
            if not members:
                result[supp['id']] = False
                continue
            start_str = group.get('startDate', date)
            start_index = group.get('startIndex', 0)
            start = datetime.strptime(start_str, '%Y-%m-%d')
            days_diff = (date_obj - start).days
            current_index = (start_index + days_diff) % len(members)
            result[supp['id']] = members[current_index] == supp['id']

    return result


def record_matches_supplement(record, supplement):
    """Match new stable IDs first, retaining pre-upgrade record compatibility."""
    supplement_id = supplement.get('id')
    if record.get('supplementId'):
        return record.get('supplementId') == supplement_id
    legacy_record_type = get_supplement_record_type(supplement)
    return (
        record.get('supplementType') == supplement_id or
        (legacy_record_type and record.get('supplementType') == legacy_record_type)
    )


def get_due_supplement_instances(settings, records, date):
    """Return one independently completable item per required daily dose."""
    result = []
    scheduled = get_today_supplements(settings, date)

    for supplement in settings.get('supplements', []):
        supplement_id = supplement['id']
        if not scheduled.get(supplement_id, False):
            continue

        intake_plan = normalize_intake_plan(supplement.get('intakePlan'))
        if intake_plan['reminderMode'] == 'timed':
            slots = intake_plan['slots']
        else:
            slots = [
                {'id': f'count_{index}', 'label': f'第{index}次', 'time': None}
                for index in range(1, intake_plan['dailyCount'] + 1)
            ]

        day_records = sorted(
            [
                record for record in records
                if record.get('type') == 'supplement' and
                record.get('time', '').startswith(date) and
                record_matches_supplement(record, supplement)
            ],
            key=lambda record: record.get('time', '')
        )
        records_by_slot = {}
        unassigned_records = []
        valid_slot_ids = {slot['id'] for slot in slots}
        for record in day_records:
            slot_id = record.get('doseSlotId')
            if slot_id in valid_slot_ids and slot_id not in records_by_slot:
                records_by_slot[slot_id] = record
            else:
                unassigned_records.append(record)

        # Records from before this upgrade did not carry a slot. Assign them
        # in chronological order so today's existing progress is not lost.
        for slot in slots:
            if slot['id'] not in records_by_slot and unassigned_records:
                records_by_slot[slot['id']] = unassigned_records.pop(0)

        legacy_record_type = get_supplement_record_type(supplement)
        for index, slot in enumerate(slots, start=1):
            record = records_by_slot.get(slot['id'])
            result.append({
                'id': f"{supplement_id}:{slot['id']}",
                'supplementId': supplement_id,
                'doseSlotId': slot['id'],
                'doseIndex': index,
                'name': supplement['name'],
                'icon': supplement.get('icon') or '💊',
                'slotLabel': slot['label'],
                'time': slot.get('time'),
                'reminderMode': intake_plan['reminderMode'],
                'legacyRecordType': legacy_record_type,
                'taken': bool(record),
                'recordTime': record.get('time') if record else None,
            })

    return result


def get_supplement_progress_items(due_items, include_hidden=False):
    """Group required doses into one user-facing progress item per supplement."""
    groups = {}
    for item in due_items:
        if not include_hidden and item['reminderMode'] == 'none':
            continue
        group = groups.setdefault(item['supplementId'], {
            'name': item['name'],
            'total': 0,
            'taken': 0,
        })
        group['total'] += 1
        group['taken'] += int(bool(item['taken']))

    return [
        group['name'] if group['total'] == 1 else f"{group['name']}（{group['taken']}/{group['total']}）"
        for group in groups.values()
        if group['taken'] < group['total']
    ]


def records_for_supplement(record):
    start = stored_record_time(record).replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        end = start + timedelta(days=1)
    except OverflowError as exc:
        raise StorageValidationError('Record date is outside the supported range') from exc
    return load_records(start=start, end=end)


def apply_supplement_intake(record, supplement_type, requested_slot_id=None, records=None):
    """Attach a record to its next pending required daily dose when applicable."""
    settings = load_supplement_settings()
    supplement = next(
        (item for item in settings.get('supplements', []) if item.get('id') == supplement_type),
        None
    )
    if not supplement:
        set_supplement_record_fields(record, supplement_type)
        return True, None

    try:
        record_date = parse_record_time(record.get('time')).strftime('%Y-%m-%d')
    except (TypeError, ValueError, AttributeError):
        record_date = now_cn_naive().strftime('%Y-%m-%d')

    other_records = [
        item for item in (records or [])
        if item.get('id') != record.get('id')
    ]
    due_items = [
        item for item in get_due_supplement_instances(settings, other_records, record_date)
        if item['supplementId'] == supplement['id']
    ]

    # Users may still make a historical or extra record on a day that this
    # supplement is not scheduled. Keep that workflow available without
    # falsely marking it as one of today's required doses.
    if not due_items:
        set_supplement_record_fields(record, supplement['id'])
        record['supplementId'] = supplement['id']
        record.pop('doseSlotId', None)
        record.pop('doseIndex', None)
        record.pop('supplementSlotLabel', None)
        return True, None

    if requested_slot_id:
        candidate = next((item for item in due_items if item['doseSlotId'] == requested_slot_id), None)
        if candidate is None:
            return False, '所选服用时段不存在'
        if candidate['taken']:
            return False, '该服用时段今天已记录'
    else:
        candidate = next((item for item in due_items if not item['taken']), None)
        if candidate is None:
            return False, '该补剂今天的计划次数已全部记录'

    set_supplement_record_fields(record, supplement['id'])
    record['supplementId'] = supplement['id']
    record['doseSlotId'] = candidate['doseSlotId']
    record['doseIndex'] = candidate['doseIndex']
    if candidate['reminderMode'] == 'timed':
        record['supplementSlotLabel'] = candidate['slotLabel']
        record['label'] = f"{record['label']} · {candidate['slotLabel']}"
        record['detail'] = record['label']
    else:
        record.pop('supplementSlotLabel', None)
    return True, None

@app.route('/api/records', methods=['GET'])
@storage_transaction
def get_records():
    """Get all records. Supports JSONP via callback parameter."""
    records = load_records()
    records.sort(key=lambda x: x.get('time', ''), reverse=True)
    callback = request.args.get('callback')
    if callback:
        json_data = json.dumps(records, ensure_ascii=False)
        resp = make_response(f'{callback}({json_data})')
        resp.headers['Content-Type'] = 'application/javascript'
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        resp.headers['X-Records-Version'] = records_file_version()
        return resp
    response = make_response(jsonify(records))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    response.headers['X-Records-Version'] = records_file_version()
    return response


@app.route('/api/records/version', methods=['GET'])
def get_records_version():
    """Return only the committed record version for low-cost polling."""
    response = make_response(jsonify({'version': records_file_version()}))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response


def parse_analysis_time(value, display_timezone, china_time=False):
    if not isinstance(value, str) or not value:
        return None
    try:
        if china_time and '+' not in value and not value.endswith('Z'):
            if 'T' not in value and ' ' not in value:
                return None
            value += '+08:00'
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc if len(value) == 10 else display_timezone)
        return parsed.replace(microsecond=parsed.microsecond // 1000 * 1000).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def build_analysis_sleep_index(records, display_timezone, china_time=False):
    timed_records = []
    for record in records:
        if record.get('type') != 'sleep':
            continue
        parsed = parse_analysis_time(record.get('time'), display_timezone, china_time)
        if parsed is not None:
            timed_records.append((record, parsed))
    timed_records.sort(key=lambda item: item[1])
    days = {}
    positions = {'left': 0, 'right': 0, 'back': 0}
    open_sleep = None
    for record, parsed in timed_records:
        if record.get('sleepType') == 'sleep':
            open_sleep = (record, parsed)
        elif record.get('sleepType') == 'awake' and open_sleep:
            start_record, start = open_sleep
            duration_ms = round((parsed - start).total_seconds() * 1000)
            if duration_ms > 0:
                date_str = start.astimezone(display_timezone).date().isoformat()
                day = days.setdefault(date_str, {'sessions': [], 'totalDurationMs': 0})
                day['sessions'].append({
                    'start': start.isoformat(),
                    'end': parsed.isoformat(),
                    'durationMs': duration_ms,
                    'isCrossDay': parsed.astimezone(display_timezone).date().isoformat() != date_str,
                    **({'sleepPosition': start_record['sleepPosition']} if 'sleepPosition' in start_record else {}),
                })
                day['totalDurationMs'] += duration_ms
                position = start_record.get('sleepPosition')
                if position in positions:
                    positions[position] += duration_ms
            open_sleep = None
    return {
        'days': days,
        'positionDurations': positions,
        'openSleep': {
            'time': open_sleep[1].isoformat(),
            'sleepPosition': open_sleep[0].get('sleepPosition'),
        } if open_sleep else None,
        'openSleepDate': open_sleep[1].astimezone(display_timezone).date().isoformat() if open_sleep else None,
    }


@lru_cache(maxsize=4)
def get_analysis_index(version, analysis_type, timezone_name, first_day=None, after_last_day=None):
    start = datetime.fromisoformat(first_day).replace(tzinfo=CN_TZ) if first_day else None
    end = datetime.fromisoformat(after_last_day).replace(tzinfo=CN_TZ) if after_last_day else None
    records = load_records(start=start, end=end)
    records.sort(key=lambda record: record.get('time') or '', reverse=True)
    display_timezone = ZoneInfo(timezone_name)
    if analysis_type == 'sleep':
        index = build_analysis_sleep_index(records, display_timezone)
        position_index = build_analysis_sleep_index(records, display_timezone, True)
        index['positionDurations'] = position_index['positionDurations']
        index['positionOpenSleep'] = position_index['openSleep']
        return index
    days = {}
    for record in records:
        parsed = parse_analysis_time(record.get('time'), CN_TZ, True)
        if parsed is None:
            continue
        date_str = parsed.astimezone(CN_TZ).date().isoformat()
        day = days.setdefault(date_str, {'records': [], 'totalMl': 0, 'newMilkCount': 0})
        day['records'].append(record)
        if record.get('type') == 'feed':
            amount = re.match(r'^[+-]?\d+', str(record.get('amount', '')).strip())
            day['totalMl'] += int(amount.group()) if amount else 0
            day['newMilkCount'] += bool(record.get('isNewMilk'))
    return {'days': days}


@app.route('/api/analysis/<analysis_type>', methods=['GET'])
@storage_transaction
def get_date_analysis(analysis_type):
    if analysis_type not in ('feeding', 'sleep'):
        return jsonify({'error': 'Unknown analysis type'}), 404
    timezone_name = request.args.get('timezone', 'Asia/Shanghai')
    try:
        display_timezone = ZoneInfo(timezone_name)
        date_str = request.args.get('date', datetime.now(display_timezone).date().isoformat())
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date_str):
            raise ValueError('Invalid date')
        selected_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        trend_end = datetime.combine(selected_date, datetime.min.time()).replace(hour=12, tzinfo=CN_TZ).astimezone(display_timezone).date()
        trend_dates = [(trend_end - timedelta(days=offset)).isoformat() for offset in range(6, -1, -1)]
        first_day = after_last_day = None
        if analysis_type == 'feeding':
            first_day = min(date_str, *trend_dates)
            after_last_day = (datetime.fromisoformat(max(date_str, *trend_dates)) + timedelta(days=1)).date().isoformat()
    except (ValueError, OverflowError, ZoneInfoNotFoundError):
        return jsonify({'error': 'Invalid date or timezone'}), 400
    for attempt in range(3):
        version = records_file_version()
        try:
            index = get_analysis_index(version, analysis_type, timezone_name, first_day, after_last_day)
        except json.JSONDecodeError:
            continue
        if version == records_file_version():
            break
    else:
        response = jsonify({'error': 'Records are changing; please retry'})
        response.status_code = 503
        response.headers['Retry-After'] = '1'
        return response
    result = {'date': date_str, 'timezone': timezone_name, 'version': version, 'type': analysis_type}
    selected_day = index['days'].get(date_str, {})
    if analysis_type == 'feeding':
        result['records'] = selected_day.get('records', [])
        result['trend'] = [{
            'dateStr': trend_date,
            'totalMl': index['days'].get(trend_date, {}).get('totalMl', 0),
            'newMilkCount': index['days'].get(trend_date, {}).get('newMilkCount', 0),
        } for trend_date in trend_dates]
    else:
        result['sessions'] = selected_day.get('sessions', [])
        result['trend'] = [{
            'dateStr': trend_date,
            'totalDurationMs': index['days'].get(trend_date, {}).get('totalDurationMs', 0),
            'sessionCount': len(index['days'].get(trend_date, {}).get('sessions', [])),
        } for trend_date in trend_dates]
        for field in ('openSleep', 'openSleepDate', 'positionDurations', 'positionOpenSleep'):
            result[field] = index[field]
    response = jsonify(result)
    response.headers['X-Records-Version'] = version
    return response


@app.route('/api/dashboard/latest-status', methods=['GET'])
def get_latest_dashboard_status():
    """Return only the three records needed by the homepage status cards."""
    latest = {'sleep': None, 'newMilk': None, 'diaper': None}
    for record in load_records():
        record_time = record.get('time') or ''
        if not record_time:
            continue
        if record.get('type') == 'sleep':
            current = latest['sleep']
            if current is None or record_time > current['time']:
                latest['sleep'] = {
                    'time': record_time,
                    'sleepType': record.get('sleepType'),
                }
        elif record.get('type') == 'feed' and record.get('isNewMilk'):
            current = latest['newMilk']
            if current is None or record_time > current['time']:
                latest['newMilk'] = {'time': record_time}
        elif record.get('type') == 'diaper':
            current = latest['diaper']
            if current is None or record_time > current['time']:
                latest['diaper'] = {'time': record_time}

    response = make_response(jsonify(latest))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response


@app.route('/records')
def all_records_page():
    """All records page with pagination and filtering."""
    page = request.args.get('page', 1, type=int)
    date_filter = request.args.get('date', '')
    type_filter = request.args.get('type', 'all')
    per_page = 20
    now = now_cn_naive()
    today = now.strftime('%Y-%m-%d')
    # Default to today if no date filter specified
    if not date_filter:
        date_filter = today
    records = load_records(date_prefix=date_filter)
    # Apply type filter
    if type_filter and type_filter != 'all':
        records = [r for r in records if r.get('type') == type_filter]
    records.sort(key=lambda x: x.get('time', ''), reverse=True)
    total = len(records)
    total_pages = max(1, (total + per_page - 1) // per_page)
    start = (page - 1) * per_page
    end = start + per_page
    page_records = records[start:end]
    has_more = end < total
    now = now_cn_naive()
    today = now.strftime('%Y-%m-%d')
    today_display = f"{now.month}月{now.day}日"
    cache_bust = now.strftime('%Y%m%d%H%M%S')
    supplement_options = [{
        **supp,
        'legacyRecordType': get_supplement_record_type(supp) or ''
    } for supp in load_supplement_settings().get('supplements', [])]
    response = make_response(render_template('records.html', records=page_records, page=page, total_pages=total_pages, has_more=has_more, cache_bust=cache_bust, date_filter=date_filter, type_filter=type_filter, today=today, today_display=today_display, supplement_options=supplement_options))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


@app.route('/records/load')
def load_more_records():
    """Load more records for infinite scroll."""
    page = request.args.get('page', 1, type=int)
    date_filter = request.args.get('date', '')
    type_filter = request.args.get('type', 'all')
    per_page = 20
    records = load_records(date_prefix=date_filter)
    if type_filter and type_filter != 'all':
        records = [r for r in records if r.get('type') == type_filter]
    records.sort(key=lambda x: x.get('time', ''), reverse=True)
    start = (page - 1) * per_page
    end = start + per_page
    page_records = records[start:end]
    has_more = end < len(records)
    return jsonify({'records': page_records, 'has_more': has_more})


@app.route('/api/records/<record_id>', methods=['POST', 'DELETE'])
@app.route('/api/records/<record_id>/delete', methods=['POST'])
@storage_transaction
def delete_record(record_id):
    """Delete an existing record."""
    if not record_store.delete_record(record_id):
        return jsonify({'error': 'Record not found'}), 404
    response = make_response(jsonify({'success': True}))
    response.headers['X-Records-Version'] = records_file_version()
    return response


@app.route('/api/records/<record_id>', methods=['POST', 'PUT'])
@app.route('/api/records/<record_id>/update', methods=['POST'])
@storage_transaction
def update_record(record_id):
    """Update an existing record."""
    data = request_data()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    record = record_store.get_record(record_id)
    if not record:
        return jsonify({'error': 'Record not found'}), 404

    record_type = record.get('type')

    # Update time if provided
    if 'time' in data:
        record['time'] = data['time']

    # Update note
    if 'note' in data:
        record['note'] = data['note']

    if record_type == 'diaper':
        if 'diaperType' in data:
            diaper_type = data['diaperType']
            if diaper_type not in ['wet', 'dirty', 'both']:
                diaper_type = 'wet'
            diaper_labels = {'wet': '💧 尿', 'dirty': '🟤 粑粑', 'both': '💫 两者'}
            record['diaperType'] = diaper_type
            record['label'] = diaper_labels.get(diaper_type, diaper_type)
            record['detail'] = record['label']

    elif record_type == 'feed':
        if 'amount' in data:
            record['amount'] = data['amount']
        if 'isNewMilk' in data:
            record['isNewMilk'] = data['isNewMilk']
        new_milk_label = '🆕 ' if record.get('isNewMilk') else ''
        detail_parts = [f"{new_milk_label}{record.get('label', '🍼 奶瓶')}"]
        if record.get('amount'):
            detail_parts.append(f"{record['amount']}ml")
        record['detail'] = ' · '.join(detail_parts)

    elif record_type == 'sleep':
        if 'sleepType' in data:
            sleep_type = data['sleepType']
            sleep_labels = {'awake': '👀 宝宝醒了', 'sleep': '🛏️ 宝宝睡了'}
            record['sleepType'] = sleep_type
            record['label'] = sleep_labels.get(sleep_type, sleep_labels['awake'])
            if sleep_type == 'sleep':
                sleep_position = data.get('sleepPosition')
                if sleep_position not in ['left', 'right', 'back']:
                    return jsonify({'error': 'sleepPosition is required when sleepType is "sleep"'}), 400
                record['sleepPosition'] = sleep_position
            else:
                record.pop('sleepPosition', None)
            record['detail'] = record['label']

    elif record_type == 'supplement':
        if any(field in data for field in ('supplementType', 'time', 'doseSlotId')):
            supplement_type = data.get('supplementType') or record.get('supplementId') or record.get('supplementType')
            requested_slot = data.get('doseSlotId')
            if requested_slot is None and supplement_type in (record.get('supplementId'), record.get('supplementType')):
                requested_slot = record.get('doseSlotId')
            success, error = apply_supplement_intake(
                record,
                supplement_type,
                requested_slot,
                records_for_supplement(record),
            )
            if not success:
                return jsonify({'error': error}), 409

    elif record_type == 'tummy':
        if 'duration' in data:
            try:
                duration = int(data.get('duration') or 1)
            except (TypeError, ValueError):
                duration = 1
            duration = max(1, duration)
            record['duration'] = duration
            record['label'] = '🧸 练趴'
            record['detail'] = f'🧸 练趴 {duration}分钟'

    elif record_type == 'health':
        health_type = data.get('healthType')
        if health_type not in ('temperature', 'medicine'):
            return jsonify({'error': 'healthType must be "temperature" or "medicine"'}), 400
        record['healthType'] = health_type
        if health_type == 'temperature':
            try:
                temperature = float(data.get('temperature'))
            except (TypeError, ValueError):
                return jsonify({'error': 'temperature must be a number'}), 400
            if not 30 <= temperature <= 45:
                return jsonify({'error': 'temperature must be between 30 and 45'}), 400
            record['temperature'] = temperature
            record.pop('medicineName', None)
            record.pop('medicineDose', None)
            record['label'] = '🌡️ 体温'
            record['detail'] = f'🌡️ 体温 {temperature:g}°C'
        else:
            medicine_name = str(data.get('medicineName') or '').strip()
            if not medicine_name:
                return jsonify({'error': 'medicineName is required'}), 400
            medicine_dose = str(data.get('medicineDose') or '').strip()
            record['medicineName'] = medicine_name
            record['medicineDose'] = medicine_dose
            record.pop('temperature', None)
            record['label'] = '💊 服药'
            record['detail'] = f'💊 服药 {medicine_name}' + (f' · {medicine_dose}' if medicine_dose else '')

    elif record_type in ('supplement', 'bath'):
        pass

    record_store.update_record(record)
    response = make_response(jsonify(record))
    response.headers['X-Records-Version'] = records_file_version()
    return response


@app.route('/api/records', methods=['POST'])
@storage_transaction
def create_record():
    """Create a new record."""
    data = request_data()

    if not data:
        return jsonify({'error': 'No data provided'}), 400

    record_type = data.get('type')
    if record_type not in ['diaper', 'feed', 'supplement', 'bath', 'sleep', 'tummy', 'health']:
        return jsonify({'error': 'Invalid record type'}), 400

    record = {
        'id': now_cn_naive().strftime('%Y%m%d%H%M%S%f'),
        'type': record_type,
        'time': data.get('time') or now_cn_naive().isoformat(timespec='seconds'),
        'note': data.get('note', ''),
    }

    if record_type == 'diaper':
        diaper_type = data.get('diaperType') or data.get('label')
        if diaper_type not in ['wet', 'dirty', 'both']:
            diaper_type = 'wet'  # Default
        diaper_labels = {'wet': '💧 尿', 'dirty': '🟤 粑粑', 'both': '💫 两者'}
        record['diaperType'] = diaper_type
        record['label'] = diaper_labels.get(diaper_type, diaper_type)
        record['detail'] = record['label']

    elif record_type == 'feed':
        feed_type = data.get('feedType') or data.get('label')
        if feed_type not in ['bottle']:
            feed_type = 'bottle'  # Default
        is_new_milk = data.get('isNewMilk', False)
        feed_labels = {'bottle': '🍼 奶瓶'}
        new_milk_label = '🆕 ' if is_new_milk else ''
        record['feedType'] = feed_type
        record['isNewMilk'] = is_new_milk
        record['label'] = feed_labels.get(feed_type, feed_type)

        # Build detail string
        detail_parts = [f"{new_milk_label}{record['label']}"]
        if data.get('amount'):
            detail_parts.append(f"{data['amount']}ml")
        record['detail'] = ' · '.join(detail_parts)
        record['amount'] = data.get('amount')

    elif record_type == 'supplement':
        supplement_type = data.get('supplementType') or data.get('vitaminType') or 'D3'
        if not supplement_type or supplement_type == 'undefined':
            supplement_type = 'D3'
        success, error = apply_supplement_intake(
            record,
            supplement_type,
            data.get('doseSlotId'),
            records_for_supplement(record),
        )
        if not success:
            return jsonify({'error': error}), 409

    elif record_type == 'bath':
        bath_type = data.get('bathType') or 'bath'
        record['bathType'] = bath_type
        record['label'] = '🛁 洗澡'
        record['detail'] = '🛁 洗澡'

    elif record_type == 'health':
        health_type = data.get('healthType')
        if health_type not in ('temperature', 'medicine'):
            return jsonify({'error': 'healthType must be "temperature" or "medicine"'}), 400
        record['healthType'] = health_type
        if health_type == 'temperature':
            try:
                temperature = float(data.get('temperature'))
            except (TypeError, ValueError):
                return jsonify({'error': 'temperature must be a number'}), 400
            if not 30 <= temperature <= 45:
                return jsonify({'error': 'temperature must be between 30 and 45'}), 400
            record['temperature'] = temperature
            record['label'] = '🌡️ 体温'
            record['detail'] = f'🌡️ 体温 {temperature:g}°C'
        else:
            medicine_name = str(data.get('medicineName') or '').strip()
            if not medicine_name:
                return jsonify({'error': 'medicineName is required'}), 400
            medicine_dose = str(data.get('medicineDose') or '').strip()
            record['medicineName'] = medicine_name
            record['medicineDose'] = medicine_dose
            record['label'] = '💊 服药'
            record['detail'] = f'💊 服药 {medicine_name}' + (f' · {medicine_dose}' if medicine_dose else '')

    elif record_type == 'tummy':
        try:
            duration = int(data.get('duration') or 1)
        except (TypeError, ValueError):
            duration = 1
        duration = max(1, duration)
        record['duration'] = duration
        record['label'] = '🧸 练趴'
        record['detail'] = f'🧸 练趴 {duration}分钟'

    elif record_type == 'sleep':
        sleep_type = data.get('sleepType') or 'awake'
        sleep_labels = {'awake': '👀 宝宝醒了', 'sleep': '🛏️ 宝宝睡了'}
        record['sleepType'] = sleep_type
        if sleep_type == 'sleep':
            sleep_position = data.get('sleepPosition')
            if sleep_position not in ['left', 'right', 'back']:
                return jsonify({'error': 'sleepPosition is required when sleepType is "sleep"'}), 400
            record['sleepPosition'] = sleep_position
        record['label'] = sleep_labels.get(sleep_type, sleep_labels['awake'])
        record['detail'] = record['label']

    record_store.insert_record(record)

    response = make_response(jsonify(record), 201)
    response.headers['X-Records-Version'] = records_file_version()
    return response


@app.route('/api/feeding-stats', methods=['GET'])
def get_feeding_stats():
    """24-hour feeding statistics grouped by feed type."""
    records = load_records()
    now = datetime.now()
    cutoff = now.timestamp() - 86400
    recent = []
    for r in records:
        try:
            time_str = r.get('time', '')
            if not time_str or 'undefined' in time_str:
                continue
            ts = datetime.fromisoformat(time_str.replace('Z', '+00:00') if 'Z' in time_str else time_str).timestamp()
            if ts > cutoff and r.get('type') in ('feed', 'supplement'):
                recent.append(r)
        except (ValueError, KeyError):
            continue

    stats = {'total': 0, 'by_type': {}}
    for r in recent:
        t = r.get('feedType') or r.get('supplementType') or r.get('type', 'other')
        stats['by_type'][t] = stats['by_type'].get(t, 0) + int(r.get('amount') or 0)
        stats['total'] += int(r.get('amount') or 0)

    return jsonify(stats)


@app.route('/api/ai-analysis', methods=['POST'])
def ai_analysis():
    """AI analysis of baby feeding data for the requested date using MiniMax."""
    # 优先使用前端传来的当前记录，避免文件读取延迟
    req_data = request_data() or {}
    records = req_data.get('records') or load_records()
    target_date = req_data.get('date')
    now = datetime.now()
    today_start = datetime(now.year, now.month, now.day)
    target_day = today_start.date()
    if target_date:
        try:
            target_day = datetime.strptime(target_date, '%Y-%m-%d').date()
        except ValueError:
            return jsonify({'error': 'invalid date'}), 400

    today_records = []
    for r in records:
        try:
            ts = r.get('time', '')
            t = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            if t.tzinfo is not None:
                t = t.astimezone().replace(tzinfo=None)  # UTC -> 本地时区 -> naive
            # 比较日期（只用 date 部分，避免时分秒干扰）
            record_date = t.date()
            if record_date == target_day:
                today_records.append(r)
        except (ValueError, TypeError):
            continue

    feeds = [r for r in today_records if r.get('type') == 'feed']
    diapers = [r for r in today_records if r.get('type') == 'diaper']
    supplements = [r for r in today_records if r.get('type') == 'supplement']
    vitamins = [r for r in supplements if r.get('supplementType') in ('D3', 'AD', 'iron')]
    probiotics = [r for r in supplements if r.get('supplementType') == 'probiotic']
    baths = [r for r in today_records if r.get('type') == 'bath']

    total_ml = sum(int(r.get('amount') or 0) for r in feeds)
    feed_count = len(feeds)
    avg_ml = total_ml // feed_count if feed_count > 0 else 0
    new_milk = sum(1 for r in feeds if r.get('isNewMilk'))
    diaper_count = len(diapers)
    diaper_wet = sum(1 for r in diapers if r.get('diaperType') in ('wet', 'both'))
    diaper_dirty = sum(1 for r in diapers if r.get('diaperType') in ('dirty', 'both'))
    vitamin_count = len(vitamins)
    probiotic_count = len(probiotics)

    # 时间上下文
    hour = now.hour
    # 按时间倒序排列，取最新记录
    feeds_sorted = sorted(feeds, key=lambda r: r.get('time', ''), reverse=True)
    last_feed = feeds_sorted[0] if feeds_sorted else None
    last_feed_delta = ''
    if last_feed:
        last_t = datetime.fromisoformat(last_feed.get('time', '').replace('Z', '+00:00'))
        if last_t.tzinfo is not None:
            last_t = last_t.astimezone().replace(tzinfo=None)  # UTC -> 本地时区
        delta_min = int((now - last_t).total_seconds() // 60)
        if delta_min < 60:
            last_feed_delta = f'{delta_min}分钟前'
        else:
            last_feed_delta = f'{delta_min // 60}小时{delta_min % 60}分钟前'
        last_feed_time = f"{last_t.hour:02d}:{last_t.minute:02d}"
    else:
        last_feed_delta = '无记录'
        last_feed_time = '无'


    # 按时长排序（最早在前，供AI分析间隔）
    feeds_sorted = sorted(feeds, key=lambda r: r.get('time', ''))
    diapers_sorted = sorted(diapers, key=lambda r: r.get('time', ''))
    others_sorted = sorted(vitamins + probiotics + baths, key=lambda r: r.get('time', ''))

    def fmt_time(ts):
        try:
            t = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            if t.tzinfo:
                t = t.astimezone()
            return f"{t.hour:02d}:{t.minute:02d}"
        except:
            return ts[11:16] if len(ts) > 16 else ts

    feedLabels = {"bottle": "🍼", "direct": "🤱", "formula": "🧴", "supplement": "💉"}
    feed_lines = []
    for r in feeds_sorted:
        amt = r.get('amount', '?')
        ftype = r.get('feedType', 'bottle')
        tag = '🆕' if r.get('isNewMilk') else ''
        feed_lines.append(f"  - {fmt_time(r['time'])} · {amt}ml {feedLabels.get(ftype, ftype)}{tag}")

    diaper_lines = []
    for r in diapers_sorted:
        d_type = r.get('diaperType', 'wet')
        label = {'wet': '💧湿', 'dirty': '💩便', 'both': '💪两者'}.get(d_type, d_type)
        diaper_lines.append(f"  - {fmt_time(r['time'])} · {label}")

    other_lines = []
    for r in others_sorted:
        rtype = r.get('type', '')
        label = {
            'supplement': r.get('detail') or r.get('label') or
                {'D3': '☀️D3', 'AD': '🌟AD', 'iron': '🔩铁', 'probiotic': '🫙益生菌'}.get(r.get('supplementType', ''), f"💊{r.get('supplementType','补剂')}"),
            'vitamin': f"💊{r.get('vitaminType','?')}",
            'probiotic': '🫙益生菌',
            'bath': '🛁洗澡'
        }.get(rtype, rtype)
        other_lines.append(f"  - {fmt_time(r['time'])} · {label}")

    analysis_date_label = target_day.strftime('%Y-%m-%d')
    feed_detail = '\n'.join(feed_lines) if feed_lines else f'  {analysis_date_label} 暂无喂奶记录'
    diaper_detail = '\n'.join(diaper_lines) if diaper_lines else f'  {analysis_date_label} 暂无尿布记录'
    other_detail = '\n'.join(other_lines) if other_lines else f'  {analysis_date_label} 无其他记录'

    # 时段标签
    if 5 <= hour < 12:
        period = '早上/上午'
    elif 12 <= hour < 14:
        period = '中午'
    elif 14 <= hour < 18:
        period = '下午'
    elif 18 <= hour < 22:
        period = '傍晚/晚上'
    else:
        period = '深夜/凌晨'

    prompt = f"""你是专业的婴儿喂养顾问。请根据以下 {analysis_date_label} 的数据，结合当前时间【{hour:02d}:{now.minute:02d}（{period}）】，分析婴儿状态并给出建议：

👶 宝宝信息：出生日期 {BABY_BIRTH_DATE}（约 {(now - datetime(2026, 3, 8)).days} 天 / {(now - datetime(2026, 3, 8)).days // 30} 个多月）

📅 {analysis_date_label} 明细（截至 {hour:02d}:{now.minute:02d}）：

🍼 喂奶记录：
{feed_detail}

🧷 尿布记录：
{diaper_detail}

💊/🫙/🛁 其他记录：
{other_detail}

请结合当前时间分析：
1. 现在处于哪个喂养周期，下一次合理喂奶时间应该是几点？
2. 当日总奶量是否足够（参考：按当前月龄估算每日总需求）
3. 喂奶间隔是否合理，有没有过密或过长？
4. 尿布情况是否正常
5. 给出具体、可操作的建议

回复请用中文，控制在200字以内，语气温暖专业，多用 Emoji。
重要：回复内容必须放在【思考内容】之后，并用 【---】 与思考内容分隔，格式如下：
思考内容：你的思考过程...
---
[这里放你的分析回复，不要有任何思考痕迹]
"""

    try:
        if not MINIMAX_API_KEY:
            return jsonify({'success': False, 'error': 'MINIMAX_API_KEY is not configured'}), 503
        import time
        t0 = time.time()
        # Direct call to MiniMax API via urllib
        payload = json.dumps({
            'model': 'MiniMax-M2.7',
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': 2000,
            'temperature': 0.8
        }).encode('utf-8')
        req = urllib.request.Request(
            MINIMAX_BASE_URL,
            data=payload,
            headers={
                'Authorization': f'Bearer {MINIMAX_API_KEY}',
                'Content-Type': 'application/json; charset=utf-8'
            },
            method='POST'
        )
        t1 = time.time()
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode('utf-8')
        t2 = time.time()
        data = json.loads(raw)
        choices = data.get('choices') or []
        choice = choices[0] if choices else {}
        msg = choice.get('message') or {}
        raw_content = msg.get('content') or ''
        # MiniMax-M2.7 reasoning: format = 裸<thinking>actual answer
        # or: 裸<thinking>---<answer>
        # Strategy: split on '---', take last segment; if no '---', take everything after last '裸'
        if '---' in raw_content:
            parts = raw_content.rsplit('---', 1)
            answer_part = parts[-1].strip()
        else:
            thinking_idx = raw_content.find('裸')
            answer_part = raw_content[thinking_idx + 1:].strip() if thinking_idx != -1 else raw_content.strip()
        # Remove leading Chinese-only junk before real content
        m = re.search(r'\n([^\n\u4e00-\u9fff])', answer_part)
        analysis = answer_part[m.start() + 1:].strip() if m else answer_part.strip()

        if not analysis.strip():
            analysis = 'AI 暂时无法分析，请稍后重试。'
        import sys; sys.stderr.write(f'[AI分析] 构造prompt: {t0:.2f}s, API调用: {t1-t0:.2f}s, 读取响应: {t2-t1:.2f}s\n'); sys.stderr.flush()
        return jsonify({'success': True, 'analysis': analysis.strip()})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/backup/restore', methods=['POST'])
def restore_backup():
    """Restore a full snapshot or a legacy records-only JSON backup."""
    data = request_data() or {}
    if not isinstance(data, dict):
        return jsonify({'success': False, 'error': '请求必须是 JSON 对象'}), 400
    try:
        with record_store.locked():
            result = record_store.restore(data.get('filename'))
            response = jsonify(result)
            response.headers['X-Records-Version'] = records_file_version()
            return response
    except BackupNotFoundError:
        return jsonify({'success': False, 'error': '备份文件不存在'}), 404


@app.route('/api/backup/list', methods=['GET'])
def list_backups():
    """列出所有备份文件"""
    return jsonify(record_store.list_backups())


start_reminder_scheduler()


if __name__ == '__main__':
    ensure_data_file()
    debug = os.getenv('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes')
    port = int(os.getenv('PORT', '8888'))
    app.run(host='0.0.0.0', port=port, debug=debug)
