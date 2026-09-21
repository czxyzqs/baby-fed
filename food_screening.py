"""Screening board, planning queue/calendar and verdicts for baby food."""

from datetime import date, datetime, timedelta, timezone
import json
import sqlite3

from flask import Blueprint, current_app, jsonify, request

from food_library import FoodLibraryError, FoodLibraryStore


SYMPTOMS = ('口周红疹', '荨麻疹', '呕吐', '腹泻', '便秘', '湿疹加重', '其他')
CN_TZ = timezone(timedelta(hours=8))


def today_cn():
    return datetime.now(CN_TZ).date()


def parse_date(value, label='日期', allow_future=False):
    try:
        parsed = date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        parsed = None
    if parsed is None or parsed.isoformat() != value:
        raise FoodLibraryError(f'请选择有效{label}')
    if not allow_future and parsed > today_cn():
        raise FoodLibraryError(f'{label}不能晚于今天')
    return parsed


def add_days(parsed, count):
    return (parsed + timedelta(days=count)).isoformat()


class FoodScreeningStore(FoodLibraryStore):
    """Reads and writes screening rounds, reactions, plans and the queue."""

    # ---------- settings ----------

    def get_int_setting(self, connection, key, default, low, high):
        row = connection.execute('SELECT value FROM food_settings WHERE key = ?', (key,)).fetchone()
        if row is None:
            return default
        try:
            value = int(json.loads(row['value']))
        except (TypeError, ValueError):
            return default
        return value if low <= value <= high else default

    def settings(self):
        with self.connect() as connection:
            return {'observe_days_default': self.get_int_setting(connection, 'observe_days_default', 3, 1, 7)}

    def save_settings(self, data):
        value = data.get('observe_days_default')
        if type(value) is not int or not 1 <= value <= 7:
            raise FoodLibraryError('默认观察天数只能是 1 到 7 天')
        with self.connect() as connection:
            connection.execute(
                'INSERT INTO food_settings (key, value) VALUES (?, ?) '
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                ('observe_days_default', json.dumps(value)),
            )
        return {'observe_days_default': value}

    # ---------- shared reads ----------

    def latest_round_map(self, connection):
        rounds = {}
        for row in connection.execute('SELECT * FROM food_rounds ORDER BY id'):
            rounds[row['food_id']] = dict(row)
        return rounds

    def round_eaten_dates(self, connection, round_id):
        return {row['date'] for row in connection.execute(
            'SELECT DISTINCT date FROM food_entries WHERE round_id = ?', (round_id,)
        )}

    def round_reactions(self, connection, round_id):
        result = []
        for row in connection.execute(
            'SELECT * FROM food_reactions WHERE round_id = ? ORDER BY date, id', (round_id,)
        ):
            item = dict(row)
            try:
                item['symptoms'] = json.loads(item['symptoms'])
            except (TypeError, ValueError):
                item['symptoms'] = []
            result.append(item)
        return result

    def food_rows(self, connection):
        foods = [dict(row) for row in connection.execute('''
            SELECT foods.*, categories.name AS category_name, categories.emoji AS category_emoji,
                   categories.is_high_allergen
            FROM foods LEFT JOIN categories ON categories.id = foods.category_id ORDER BY foods.id
        ''')]
        return foods

    def food_status(self, food, latest):
        if latest is None:
            return 'untouched'
        return {'active': 'screening', 'normal': 'normal', 'allergic': 'allergic'}[latest['status']]

    # ---------- board ----------

    def board(self):
        with self.connect() as connection:
            foods = self.food_rows(connection)
            rounds = self.latest_round_map(connection)
            all_rounds = {}
            for row in connection.execute('SELECT * FROM food_rounds ORDER BY id'):
                all_rounds.setdefault(row['food_id'], []).append(dict(row))
            for food in foods:
                latest = rounds.get(food['id'])
                food['status'] = self.food_status(food, latest)
                food['is_high_allergen'] = bool(food['is_high_allergen'])
                food['in_queue'] = connection.execute(
                    'SELECT 1 FROM food_queue WHERE food_id = ? LIMIT 1', (food['id'],)
                ).fetchone() is not None
                food['rounds'] = []
                for item in all_rounds.get(food['id'], []):
                    food['rounds'].append({
                        'id': item['id'], 'start_date': item['start_date'],
                        'observe_days': item['observe_days'], 'status': item['status'],
                        'eaten_days': len(self.round_eaten_dates(connection, item['id'])),
                        'reactions': self.round_reactions(connection, item['id']),
                    })
                if latest is not None:
                    eaten = self.round_eaten_dates(connection, latest['id'])
                    food['start_date'] = latest['start_date']
                    food['observe_days'] = latest['observe_days']
                    food['eaten_days'] = len(eaten)
                    food['eaten_today'] = today_cn().isoformat() in eaten
                    food['reactions'] = food['rounds'][-1]['reactions']
            return {'foods': foods, 'settings': self.settings_in(connection), 'today': today_cn().isoformat()}

    def settings_in(self, connection):
        return {'observe_days_default': self.get_int_setting(connection, 'observe_days_default', 3, 1, 7)}

    # ---------- reactions & verdicts ----------

    def add_reaction(self, data):
        food_id = data.get('food_id')
        if type(food_id) is not int:
            raise FoodLibraryError('请选择有效食物')
        reaction_date = parse_date(data.get('date') or today_cn().isoformat(), '反应日期')
        symptoms = data.get('symptoms')
        if not isinstance(symptoms, list) or not symptoms or len(symptoms) > len(SYMPTOMS):
            raise FoodLibraryError('请至少选择一项症状')
        if any(item not in SYMPTOMS for item in symptoms):
            raise FoodLibraryError('包含无效的症状选项')
        note = data.get('note', '')
        if not isinstance(note, str) or len(note) > 500:
            raise FoodLibraryError('备注最多 500 个字符')
        with self.connect() as connection:
            if connection.execute('SELECT 1 FROM foods WHERE id = ?', (food_id,)).fetchone() is None:
                raise FoodLibraryError('该食物已不存在，请刷新后重试', 404)
            latest = connection.execute(
                'SELECT * FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (food_id,)
            ).fetchone()
            if latest is None:
                raise FoodLibraryError('该食物还没有排敏轮次，请先记录进食')
            connection.execute(
                'INSERT INTO food_reactions (round_id, date, symptoms, note, created_at) VALUES (?, ?, ?, ?, ?)',
                (latest['id'], reaction_date.isoformat(), json.dumps(symptoms, ensure_ascii=False), note.strip(),
                 datetime.now(CN_TZ).isoformat()),
            )
            return {'food_id': food_id}

    def verdict(self, data):
        food_id = data.get('food_id')
        if type(food_id) is not int:
            raise FoodLibraryError('请选择有效食物')
        action = data.get('action')
        if action not in ('normal', 'allergic', 'retry'):
            raise FoodLibraryError('请选择有效的判定操作')
        symptoms = data.get('symptoms') or []
        note = data.get('note', '')
        pause_days = data.get('pause_days')
        if action == 'allergic':
            if not isinstance(symptoms, list) or not symptoms:
                raise FoodLibraryError('标记过敏请至少选择一项症状')
            if any(item not in SYMPTOMS for item in symptoms):
                raise FoodLibraryError('包含无效的症状选项')
            if pause_days is not None and (type(pause_days) is not int or not 0 <= pause_days <= 14):
                raise FoodLibraryError('顺延天数只能是 0 到 14 天')
        if not isinstance(note, str) or len(note) > 500:
            raise FoodLibraryError('备注最多 500 个字符')
        today = today_cn()
        now = datetime.now(CN_TZ).isoformat()
        with self.connect() as connection:
            if connection.execute('SELECT 1 FROM foods WHERE id = ?', (food_id,)).fetchone() is None:
                raise FoodLibraryError('该食物已不存在，请刷新后重试', 404)
            latest = connection.execute(
                'SELECT * FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (food_id,)
            ).fetchone()
            if latest is None:
                raise FoodLibraryError('该食物还没有排敏轮次，无法判定')
            if action == 'normal':
                if latest['status'] not in ('active', 'allergic'):
                    raise FoodLibraryError('只有排敏中或过敏的食物可以标记正常', 409)
                connection.execute("UPDATE food_rounds SET status = 'normal' WHERE id = ?", (latest['id'],))
            elif action == 'allergic':
                if latest['status'] == 'allergic':
                    raise FoodLibraryError('该食物已是过敏状态', 409)
                connection.execute(
                    'INSERT INTO food_reactions (round_id, date, symptoms, note, created_at) VALUES (?, ?, ?, ?, ?)',
                    (latest['id'], today.isoformat(), json.dumps(symptoms, ensure_ascii=False), note.strip(), now),
                )
                connection.execute("UPDATE food_rounds SET status = 'allergic' WHERE id = ?", (latest['id'],))
                if pause_days:
                    start = add_days(today, 1)
                    connection.execute(
                        'INSERT INTO food_pauses (start_date, end_date, reason, source, created_at) VALUES (?, ?, ?, ?, ?)',
                        (start, add_days(today, pause_days), '等过敏反应消退（自动生成）', 'allergy', now),
                    )
                    self.repack(connection)
            else:
                if latest['status'] not in ('allergic', 'normal'):
                    raise FoodLibraryError('只有过敏或已正常的食物可以重新尝试', 409)
                days = latest['observe_days'] if latest['observe_days'] else 3
                connection.execute(
                    "INSERT INTO food_rounds (food_id, start_date, observe_days, status, created_at) VALUES (?, ?, ?, 'active', ?)",
                    (food_id, today.isoformat(), days, now),
                )
            connection.execute("DELETE FROM food_plan_blocks WHERE food_id = ? AND status = 'scheduled'", (food_id,))
            connection.execute('DELETE FROM food_queue WHERE food_id = ?', (food_id,))
            return {'food_id': food_id, 'action': action}

    # ---------- queue ----------

    def queue(self):
        with self.connect() as connection:
            return {'queue': self.queue_in(connection), 'settings': self.settings_in(connection)}

    def queue_in(self, connection):
        default_days = self.get_int_setting(connection, 'observe_days_default', 3, 1, 7)
        rounds = self.latest_round_map(connection)
        items = []
        for row in connection.execute('''
            SELECT food_queue.*, foods.name AS food_name, categories.name AS category_name,
                   categories.emoji AS category_emoji, categories.is_high_allergen
            FROM food_queue JOIN foods ON foods.id = food_queue.food_id
            LEFT JOIN categories ON categories.id = foods.category_id
            ORDER BY food_queue.sort_order, food_queue.id
        '''):
            item = dict(row)
            item['is_high_allergen'] = bool(item['is_high_allergen'])
            item['observe_days'] = item['observe_days'] or default_days
            item['status'] = self.food_status(item, rounds.get(item['food_id']))
            items.append(item)
        return items

    def queue_add(self, data):
        food_id = data.get('food_id')
        if type(food_id) is not int:
            raise FoodLibraryError('请选择有效食物')
        days = data.get('observe_days')
        if days is not None and (type(days) is not int or not 1 <= days <= 14):
            raise FoodLibraryError('观察天数只能是 1 到 14 天')
        with self.connect() as connection:
            if connection.execute('SELECT 1 FROM foods WHERE id = ?', (food_id,)).fetchone() is None:
                raise FoodLibraryError('该食物已不存在，请刷新后重试', 404)
            latest = connection.execute(
                'SELECT * FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (food_id,)
            ).fetchone()
            if latest is not None:
                raise FoodLibraryError('只有未排敏的食物才能加入队列', 409)
            if connection.execute('SELECT 1 FROM food_queue WHERE food_id = ?', (food_id,)).fetchone():
                raise FoodLibraryError('该食物已在队列中', 409)
            cursor = connection.execute(
                'INSERT INTO food_queue (food_id, sort_order, observe_days, created_at) VALUES (?, ?, ?, ?)',
                (food_id, (connection.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 FROM food_queue').fetchone()[0]),
                 days, datetime.now(CN_TZ).isoformat()),
            )
            return cursor.lastrowid

    def queue_change(self, identifier, data):
        with self.connect() as connection:
            row = connection.execute('SELECT * FROM food_queue WHERE id = ?', (identifier,)).fetchone()
            if row is None:
                raise FoodLibraryError('队列项已不存在，请刷新后重试', 404)
            if 'observe_days' in data:
                days = data.get('observe_days')
                if type(days) is not int or not 1 <= days <= 14:
                    raise FoodLibraryError('观察天数只能是 1 到 14 天')
                connection.execute('UPDATE food_queue SET observe_days = ? WHERE id = ?', (days, identifier))
            direction = data.get('move')
            if direction in ('up', 'down'):
                order = [item['id'] for item in connection.execute(
                    'SELECT id FROM food_queue ORDER BY sort_order, id'
                )]
                index = order.index(identifier)
                target = index - 1 if direction == 'up' else index + 1
                if 0 <= target < len(order):
                    order[index], order[target] = order[target], order[index]
                    connection.executemany(
                        'UPDATE food_queue SET sort_order = ? WHERE id = ?',
                        [(position, item) for position, item in enumerate(order)],
                    )
            return identifier

    def queue_remove(self, identifier):
        with self.connect() as connection:
            if connection.execute('SELECT 1 FROM food_queue WHERE id = ?', (identifier,)).fetchone() is None:
                raise FoodLibraryError('队列项已不存在，请刷新后重试', 404)
            connection.execute('DELETE FROM food_queue WHERE id = ?', (identifier,))

    def queue_reorder(self, ids):
        if not isinstance(ids, list) or not ids or len(ids) > 100:
            raise FoodLibraryError('请提交有效的队列顺序')
        if any(type(item) is not int for item in ids) or len(set(ids)) != len(ids):
            raise FoodLibraryError('队列顺序包含无效项')
        with self.connect() as connection:
            existing = {row['id'] for row in connection.execute('SELECT id FROM food_queue')}
            if set(ids) != existing:
                raise FoodLibraryError('队列已变化，请刷新后重试', 409)
            connection.executemany(
                'UPDATE food_queue SET sort_order = ? WHERE id = ?',
                [(position, item) for position, item in enumerate(ids)],
            )

    # ---------- schedule ----------

    def block_intervals_in(self, connection, include_rounds=True):
        intervals = []
        for row in connection.execute("SELECT * FROM food_plan_blocks WHERE status = 'scheduled'"):
            intervals.append({
                'kind': 'block', 'id': row['id'], 'food_id': row['food_id'],
                'start': row['start_date'], 'end': add_days(date.fromisoformat(row['start_date']), row['days'] - 1),
                'days': row['days'], 'pinned': bool(row['pinned']),
            })
        if include_rounds:
            rounds = self.latest_round_map(connection)
            for food_id, item in rounds.items():
                if item['status'] == 'active':
                    intervals.append({
                        'kind': 'round', 'food_id': food_id, 'id': item['id'],
                        'start': item['start_date'],
                        'end': add_days(date.fromisoformat(item['start_date']), item['observe_days'] - 1),
                        'days': item['observe_days'], 'pinned': True,
                    })
        return intervals

    def conflicts_in(self, connection):
        intervals = self.block_intervals_in(connection)
        names = {row['id']: row['name'] for row in connection.execute('SELECT id, name FROM foods')}
        conflicts = []
        for i in range(len(intervals)):
            for j in range(i + 1, len(intervals)):
                first, second = intervals[i], intervals[j]
                if first['food_id'] == second['food_id']:
                    continue
                if first['start'] <= second['end'] and second['start'] <= first['end']:
                    conflicts.append({
                        'foods': [names.get(first['food_id']), names.get(second['food_id'])],
                        'first': {'start': first['start'], 'end': first['end']},
                        'second': {'start': second['start'], 'end': second['end']},
                    })
        return conflicts

    def schedule(self):
        with self.connect() as connection:
            return self.schedule_in(connection)

    def schedule_in(self, connection):
        today = today_cn().isoformat()
        rounds = self.latest_round_map(connection)
        status_by_food = {food_id: self.food_status(None, item) for food_id, item in rounds.items()}
        blocks = []
        for row in connection.execute('SELECT * FROM food_plan_blocks ORDER BY start_date, id'):
            block = dict(row)
            block['pinned'] = bool(block['pinned'])
            block['food_status'] = status_by_food.get(block['food_id'], 'untouched')
            if block['status'] == 'scheduled' and block['food_status'] == 'screening':
                block['live'] = True
            elif block['status'] == 'scheduled' and block['food_status'] != 'untouched':
                block['stale'] = True
            blocks.append(block)
        pauses = [dict(row) for row in connection.execute('SELECT * FROM food_pauses ORDER BY start_date, id')]
        rounds = [dict(row) for row in connection.execute(
            'SELECT r.id, r.food_id, r.start_date, r.observe_days, f.name AS food_name '
            'FROM food_rounds r JOIN foods f ON f.id = r.food_id '
            "WHERE r.status = 'active' ORDER BY r.start_date, r.id"
        )]
        for item in rounds:
            item['end_date'] = add_days(date.fromisoformat(item['start_date']), item['observe_days'] - 1)
        normals = []
        for row in connection.execute('SELECT * FROM food_normal_plans ORDER BY start_date, id'):
            item = dict(row)
            item['food_status'] = status_by_food.get(item['food_id'], 'untouched')
            normals.append(item)
        return {
            'today': today,
            'blocks': blocks, 'pauses': pauses, 'normals': normals, 'rounds': rounds,
            'queue': self.queue_in(connection),
            'conflicts': self.conflicts_in(connection),
            'foods': {str(row['id']): row['name'] for row in connection.execute('SELECT id, name FROM foods')},
            'normal_foods': [
                {'id': row['id'], 'name': row['name']}
                for row in connection.execute('''
                    SELECT foods.id, foods.name FROM foods
                    WHERE foods.id NOT IN (SELECT food_id FROM food_rounds WHERE status IN ('active', 'allergic'))
                    AND foods.id IN (SELECT food_id FROM food_rounds WHERE status = 'normal')
                    ORDER BY foods.name
                ''')
            ],
            'settings': self.settings_in(connection),
        }

    def pack_start(self, connection):
        latest_end = today_cn().isoformat()
        for interval in self.block_intervals_in(connection):
            if interval['end'] > latest_end:
                latest_end = interval['end']
        for row in connection.execute('SELECT end_date FROM food_pauses'):
            if row['end_date'] > latest_end:
                latest_end = row['end_date']
        return add_days(date.fromisoformat(latest_end), 1)

    def auto_schedule(self):
        with self.connect() as connection:
            queue = [dict(row) for row in connection.execute(
                'SELECT * FROM food_queue ORDER BY sort_order, id'
            )]
            if not queue:
                return self.schedule_in(connection)
            default_days = self.get_int_setting(connection, 'observe_days_default', 3, 1, 7)
            rounds = self.latest_round_map(connection)
            cursor_date = date.fromisoformat(self.pack_start(connection))
            now = datetime.now(CN_TZ).isoformat()
            for item in queue:
                if rounds.get(item['food_id']) is not None:
                    continue
                days = item['observe_days'] or default_days
                connection.execute(
                    "INSERT INTO food_plan_blocks (food_id, start_date, days, pinned, status, created_at, updated_at) "
                    "VALUES (?, ?, ?, 0, 'scheduled', ?, ?)",
                    (item['food_id'], cursor_date.isoformat(), days, now, now),
                )
                cursor_date = cursor_date + timedelta(days=days)
                connection.execute('DELETE FROM food_queue WHERE id = ?', (item['id'],))
            return self.schedule_in(connection)

    def repack(self, connection):
        fixed = [interval for interval in self.block_intervals_in(connection, include_rounds=True)
                 if interval['kind'] == 'round' or interval['pinned']]
        cursor = today_cn()
        for interval in fixed:
            end = date.fromisoformat(interval['end'])
            if end > cursor:
                cursor = end
        for row in connection.execute('SELECT end_date FROM food_pauses'):
            candidate = date.fromisoformat(row['end_date'])
            if candidate > cursor:
                cursor = candidate
        now = datetime.now(CN_TZ).isoformat()
        order = [dict(row) for row in connection.execute(
            "SELECT * FROM food_plan_blocks WHERE status = 'scheduled' AND pinned = 0 ORDER BY start_date, id"
        )]
        for block in order:
            cursor = cursor + timedelta(days=1)
            connection.execute(
                'UPDATE food_plan_blocks SET start_date = ?, updated_at = ? WHERE id = ?',
                (cursor.isoformat(), now, block['id']),
            )
            cursor = cursor + timedelta(days=block['days'] - 1)

    def repack_schedule(self):
        with self.connect() as connection:
            self.repack(connection)
            return self.schedule_in(connection)

    def update_block(self, identifier, data):
        with self.connect() as connection:
            row = connection.execute('SELECT * FROM food_plan_blocks WHERE id = ?', (identifier,)).fetchone()
            if row is None:
                raise FoodLibraryError('计划区块已不存在，请刷新后重试', 404)
            block = dict(row)
            today = today_cn()
            updates = {}
            if 'start_date' in data:
                start = parse_date(data['start_date'], '开始日期', allow_future=True)
                if block['status'] != 'scheduled':
                    raise FoodLibraryError('进行中或已完成的计划不能再移动', 409)
                if start <= today:
                    raise FoodLibraryError('计划只能移动到今天之后')
                updates['start_date'] = start.isoformat()
                updates['pinned'] = 1
            if 'days' in data:
                days = data.get('days')
                if type(days) is not int or not 1 <= days <= 14:
                    raise FoodLibraryError('观察天数只能是 1 到 14 天')
                latest = connection.execute(
                    'SELECT * FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (block['food_id'],)
                ).fetchone()
                if latest is not None and latest['status'] == 'active':
                    eaten = len(self.round_eaten_dates(connection, latest['id']))
                    if days <= eaten or days < block['days']:
                        raise FoodLibraryError('进行中的观察只能延长，且不能少于已吃天数')
                updates['days'] = days
            if 'pinned' in data:
                if not isinstance(data['pinned'], bool):
                    raise FoodLibraryError('固定标记必须为布尔值')
                updates['pinned'] = 1 if data['pinned'] else 0
            if not updates:
                raise FoodLibraryError('没有需要修改的内容')
            updates['updated_at'] = datetime.now(CN_TZ).isoformat()
            assignments = ', '.join(f'{key} = ?' for key in updates)
            connection.execute(
                f'UPDATE food_plan_blocks SET {assignments} WHERE id = ?',
                (*updates.values(), identifier),
            )
            return self.schedule_in(connection)

    def delete_block(self, identifier):
        with self.connect() as connection:
            row = connection.execute('SELECT * FROM food_plan_blocks WHERE id = ?', (identifier,)).fetchone()
            if row is None:
                raise FoodLibraryError('计划区块已不存在，请刷新后重试', 404)
            connection.execute('DELETE FROM food_plan_blocks WHERE id = ?', (identifier,))
            latest = connection.execute(
                'SELECT * FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (row['food_id'],)
            ).fetchone()
            if latest is None and connection.execute(
                'SELECT 1 FROM food_queue WHERE food_id = ?', (row['food_id'],)
            ).fetchone() is None:
                connection.execute(
                    'INSERT INTO food_queue (food_id, sort_order, observe_days, created_at) VALUES (?, ?, ?, ?)',
                    (row['food_id'],
                     connection.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 FROM food_queue').fetchone()[0],
                     None, datetime.now(CN_TZ).isoformat()),
                )
            return self.schedule_in(connection)

    def add_pause(self, data):
        start = parse_date(data.get('start_date'), '暂停开始日期', allow_future=True)
        end_value = data.get('end_date')
        try:
            end = date.fromisoformat(end_value) if isinstance(end_value, str) else None
        except ValueError:
            end = None
        if end is None or end.isoformat() != end_value:
            raise FoodLibraryError('请选择有效的暂停结束日期')
        if end < start:
            raise FoodLibraryError('暂停结束日期不能早于开始日期')
        reason = data.get('reason', '')
        if not isinstance(reason, str) or len(reason) > 50:
            raise FoodLibraryError('暂停原因最多 50 个字符')
        with self.connect() as connection:
            connection.execute(
                'INSERT INTO food_pauses (start_date, end_date, reason, source, created_at) VALUES (?, ?, ?, ?, ?)',
                (start.isoformat(), end.isoformat(), reason.strip(), 'manual', datetime.now(CN_TZ).isoformat()),
            )
            return self.schedule_in(connection)

    def delete_pause(self, identifier):
        with self.connect() as connection:
            if connection.execute('SELECT 1 FROM food_pauses WHERE id = ?', (identifier,)).fetchone() is None:
                raise FoodLibraryError('暂停段已不存在，请刷新后重试', 404)
            connection.execute('DELETE FROM food_pauses WHERE id = ?', (identifier,))
            return self.schedule_in(connection)

    def add_normal(self, data):
        food_id = data.get('food_id')
        if type(food_id) is not int:
            raise FoodLibraryError('请选择有效食物')
        start = parse_date(data.get('start_date'), '计划日期', allow_future=True)
        days = data.get('days', 1)
        if type(days) is not int or not 1 <= days <= 14:
            raise FoodLibraryError('常规计划最多连续 14 天')
        with self.connect() as connection:
            if connection.execute('SELECT 1 FROM foods WHERE id = ?', (food_id,)).fetchone() is None:
                raise FoodLibraryError('该食物已不存在，请刷新后重试', 404)
            latest = connection.execute(
                'SELECT * FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (food_id,)
            ).fetchone()
            if latest is None or latest['status'] != 'normal':
                raise FoodLibraryError('常规计划只能选择已正常的食物，未排敏食物请加入排敏队列', 409)
            connection.execute(
                'INSERT INTO food_normal_plans (food_id, start_date, days, created_at) VALUES (?, ?, ?, ?)',
                (food_id, start.isoformat(), days, datetime.now(CN_TZ).isoformat()),
            )
            return self.schedule_in(connection)

    def delete_normal(self, identifier):
        with self.connect() as connection:
            if connection.execute('SELECT 1 FROM food_normal_plans WHERE id = ?', (identifier,)).fetchone() is None:
                raise FoodLibraryError('常规计划已不存在，请刷新后重试', 404)
            connection.execute('DELETE FROM food_normal_plans WHERE id = ?', (identifier,))
            return self.schedule_in(connection)

    # ---------- banner & prefill ----------

    def banner(self):
        with self.connect() as connection:
            today = today_cn().isoformat()
            items = []
            rounds = self.latest_round_map(connection)
            names = {row['id']: row['name'] for row in connection.execute('SELECT id, name FROM foods')}
            for food_id, latest in rounds.items():
                if latest['status'] != 'active':
                    continue
                eaten = self.round_eaten_dates(connection, latest['id'])
                eaten_days = len(eaten)
                observe_days = latest['observe_days']
                window_end = add_days(date.fromisoformat(latest['start_date']), observe_days - 1)
                if eaten_days >= observe_days:
                    items.append({
                        'kind': 'due', 'food_id': food_id, 'food': names.get(food_id),
                        'eaten_days': eaten_days, 'observe_days': observe_days,
                        'text': f'已吃满 {observe_days} 个进食日，可标记结果',
                    })
                elif latest['start_date'] <= today <= window_end:
                    position = eaten_days + (0 if today in eaten else 1)
                    items.append({
                        'kind': 'screening', 'food_id': food_id, 'food': names.get(food_id),
                        'position': position, 'eaten_days': eaten_days, 'observe_days': observe_days,
                        'eaten_today': today in eaten,
                        'text': f'第{position}天/{observe_days}天' + ('' if today in eaten else ' · 今天还没吃'),
                    })
            for row in connection.execute(
                "SELECT p.*, foods.name AS food_name FROM food_plan_blocks p JOIN foods ON foods.id = p.food_id "
                "WHERE p.status = 'scheduled' AND p.start_date <= ? AND date(p.start_date, '+' || (p.days - 1) || ' days') >= ? "
                "ORDER BY p.start_date", (today, today)
            ):
                latest = rounds.get(row['food_id'])
                if latest is not None:
                    continue
                index = (date.fromisoformat(today) - date.fromisoformat(row['start_date'])).days + 1
                items.append({
                    'kind': 'planned', 'food_id': row['food_id'], 'food': row['food_name'],
                    'position': index, 'observe_days': row['days'],
                    'text': f'第{index}天/{row["days"]}天',
                })
            for row in connection.execute(
                "SELECT n.*, foods.name AS food_name FROM food_normal_plans n JOIN foods ON foods.id = n.food_id "
                "WHERE n.start_date <= ? AND date(n.start_date, '+' || (n.days - 1) || ' days') >= ? ORDER BY n.start_date",
                (today, today),
            ):
                items.append({'kind': 'normal', 'food_id': row['food_id'], 'food': row['food_name'], 'text': ''})
            return {'date': today, 'items': items}

    def plans_for_date(self, value):
        selected = parse_date(value)
        with self.connect() as connection:
            end = selected.isoformat()
            rounds = self.latest_round_map(connection)
            items = []
            for row in connection.execute(
                "SELECT p.*, foods.name AS food_name FROM food_plan_blocks p JOIN foods ON foods.id = p.food_id "
                "WHERE p.status = 'scheduled' AND p.start_date <= ? AND date(p.start_date, '+' || (p.days - 1) || ' days') >= ?",
                (end, end),
            ):
                if rounds.get(row['food_id']) is not None:
                    continue
                index = (selected - date.fromisoformat(row['start_date'])).days + 1
                items.append({
                    'food_id': row['food_id'], 'food_name': row['food_name'],
                    'is_new': True, 'position': index, 'observe_days': row['days'],
                })
            for row in connection.execute(
                'SELECT n.*, foods.name AS food_name FROM food_normal_plans n JOIN foods ON foods.id = n.food_id '
                'WHERE n.start_date <= ? AND date(n.start_date, "+" || (n.days - 1) || " days") >= ?',
                (end, end),
            ):
                items.append({'food_id': row['food_id'], 'food_name': row['food_name'], 'is_new': False})
            return {'date': end, 'items': items}

    # ---------- stats ----------

    def stats(self):
        with self.connect() as connection:
            foods = self.food_rows(connection)
            rounds = self.latest_round_map(connection)
            counts = {'untouched': 0, 'screening': 0, 'normal': 0, 'allergic': 0}
            coverage = {}
            for food in foods:
                status = self.food_status(food, rounds.get(food['id']))
                food['status'] = status
                counts[status] += 1
                entry = coverage.setdefault(
                    food['category_name'] or '未分组',
                    {'name': food['category_name'] or '未分组', 'emoji': food['category_emoji'] or '🍚',
                     'high_allergen': bool(food['is_high_allergen']), 'total': 0, 'tried': 0},
                )
                entry['total'] += 1
                if status != 'untouched':
                    entry['tried'] += 1
            month_prefix = today_cn().strftime('%Y-%m')
            monthly = []
            seen = set()
            for row in connection.execute(
                'SELECT r.food_id, r.start_date, f.name AS food_name FROM food_rounds r '
                'JOIN foods f ON f.id = r.food_id ORDER BY r.id'
            ):
                if row['food_id'] in seen or not row['start_date'].startswith(month_prefix):
                    continue
                seen.add(row['food_id'])
                monthly.append({'food': row['food_name'], 'date': row['start_date']})
            taste = {'like': [], 'reject': []}
            for row in connection.execute(
                "SELECT food_name, rating, COUNT(*) AS total FROM food_entries "
                "WHERE rating IN ('喜欢', '拒绝') GROUP BY food_name, rating ORDER BY total DESC"
            ):
                entry = {'food': row['food_name'], 'count': row['total']}
                taste['like' if row['rating'] == '喜欢' else 'reject'].append(entry)
            allergic = []
            for food in foods:
                if food['status'] != 'allergic':
                    continue
                latest = rounds.get(food['id'])
                reactions = self.round_reactions(connection, latest['id']) if latest else []
                last_date = reactions[-1]['date'] if reactions else (latest['start_date'] if latest else '')
                allergic.append({
                    'food': food['name'], 'first_date': latest['start_date'] if latest else '',
                    'last_reaction': last_date,
                    'symptoms': sorted({item for row in reactions for item in row['symptoms']}),
                })
            return {
                'counts': counts,
                'tried': counts['screening'] + counts['normal'] + counts['allergic'],
                'coverage': list(coverage.values()),
                'monthly': monthly,
                'taste': {'like': taste['like'][:5], 'reject': taste['reject']},
                'allergic': allergic,
            }


def register_food_screening(app, data_dir):
    store = FoodScreeningStore(data_dir)
    blueprint = Blueprint('food_screening', __name__, url_prefix='/api/screening')

    def payload():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise FoodLibraryError('请提交有效的 JSON 对象')
        return data

    def identifier(value):
        if type(value) is not int or value <= 0:
            raise FoodLibraryError('无效的编号', 404)
        return value

    @blueprint.errorhandler(FoodLibraryError)
    def invalid_input(error):
        return jsonify({'success': False, 'error': str(error)}), error.status

    @blueprint.errorhandler(sqlite3.Error)
    @blueprint.errorhandler(OSError)
    def unavailable(error):
        current_app.logger.error('Food screening unavailable: %s', error)
        return jsonify({'success': False, 'error': '排敏数据暂时无法读写，请稍后重试'}), 503

    @blueprint.errorhandler(Exception)
    def unexpected(error):
        from werkzeug.exceptions import HTTPException
        if isinstance(error, HTTPException):
            return jsonify({'success': False, 'error': error.description}), error.code
        current_app.logger.exception('Food screening error: %s', error)
        return jsonify({'success': False, 'error': '排敏服务内部错误，请稍后重试'}), 500

    @blueprint.get('/board')
    def get_board():
        return jsonify(store.board())

    @blueprint.get('/settings')
    def get_settings():
        return jsonify(store.settings())

    @blueprint.put('/settings')
    def put_settings():
        result = store.save_settings(payload())
        return jsonify({'success': True, **result})

    @blueprint.post('/reactions')
    def post_reaction():
        store.add_reaction(payload())
        return jsonify({'success': True}), 201

    @blueprint.post('/verdict')
    def post_verdict():
        store.verdict(payload())
        return jsonify({'success': True})

    @blueprint.get('/queue')
    def get_queue():
        return jsonify(store.queue())

    @blueprint.post('/queue')
    def add_queue_item():
        result = store.queue_add(payload())
        return jsonify({'success': True, 'id': result}), 201

    @blueprint.route('/queue/<int:item_id>', methods=['PUT', 'DELETE'])
    def change_queue_item(item_id):
        if request.method == 'DELETE':
            store.queue_remove(item_id)
        else:
            store.queue_change(item_id, payload())
        return jsonify({'success': True})

    @blueprint.put('/queue/order')
    def reorder_queue():
        store.queue_reorder(payload().get('ids'))
        return jsonify({'success': True})

    @blueprint.get('/schedule')
    def get_schedule():
        return jsonify(store.schedule())

    @blueprint.post('/schedule/auto')
    def auto_pack():
        return jsonify({'success': True, **store.auto_schedule()})

    @blueprint.post('/schedule/repack')
    def repack_blocks():
        return jsonify({'success': True, **store.repack_schedule()})

    @blueprint.route('/blocks/<int:block_id>', methods=['PUT', 'DELETE'])
    def change_block(block_id):
        identifier(block_id)
        if request.method == 'DELETE':
            return jsonify({'success': True, **store.delete_block(block_id)})
        return jsonify({'success': True, **store.update_block(block_id, payload())})

    @blueprint.post('/pauses')
    def add_pause_segment():
        return jsonify({'success': True, **store.add_pause(payload())})

    @blueprint.route('/pauses/<int:pause_id>', methods=['DELETE'])
    def remove_pause(pause_id):
        identifier(pause_id)
        return jsonify({'success': True, **store.delete_pause(pause_id)})

    @blueprint.post('/normals')
    def add_normal_plan():
        return jsonify({'success': True, **store.add_normal(payload())})

    @blueprint.route('/normals/<int:plan_id>', methods=['DELETE'])
    def remove_normal(plan_id):
        identifier(plan_id)
        return jsonify({'success': True, **store.delete_normal(plan_id)})

    @blueprint.get('/banner')
    def get_banner():
        return jsonify(store.banner())

    @blueprint.get('/plans')
    def get_plans():
        selected = request.args.get('date')
        if not selected:
            raise FoodLibraryError('请提供日期参数')
        return jsonify(store.plans_for_date(selected))

    @blueprint.get('/stats')
    def get_stats():
        return jsonify(store.stats())

    app.register_blueprint(blueprint)
