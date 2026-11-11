"""Food intake records stored alongside the food library: 一笔=同日同进食时间的条目组."""

from datetime import date, datetime, timedelta, timezone
import json
import sqlite3

from flask import Blueprint, current_app, jsonify, request

from food_library import FoodLibraryError, FoodLibraryStore, slot_for_time


# 槽位代号全集（计划侧词汇；记录侧不存餐次，展示时按时间落槽推导）
MEALS = ('breakfast', 'lunch', 'snack', 'dinner')
AMOUNTS = ('一勺尖', '一勺', '两勺', '三勺', '半碗', '一碗')
PORTION_AMOUNTS = ('0.5份', '1份', '1.5份', '2份', '2.5份', '3份', '3.5份', '4份')
ALL_AMOUNTS = AMOUNTS + PORTION_AMOUNTS
RATINGS = ('喜欢', '一般', '拒绝')
# 备餐按"份"记录：份×当批含量折算克数；无标定的批次克数为 0，份仅作取用单位
# 摄入汇总的大类映射（按品类名归并）与勺当量（主食无克数时的近似展示）
MACRO_GROUPS = {
    '荤': ('畜禽肉类', '鱼虾贝类', '肝类', '蛋类'),
    '菜': ('蔬菜类',),
    '主食': ('谷薯类',),
}
MACRO_EMOJI = {'荤': '🥩', '菜': '🥬', '主食': '🍚'}
SPOON_EQUIV = {'一勺尖': 0.5, '一勺': 1, '两勺': 2, '三勺': 3, '半碗': 2.5, '一碗': 5}
CN_TZ = timezone(timedelta(hours=8))


def valid_time(value):
    """进食时间 HH:MM。"""
    if not isinstance(value, str) or len(value) != 5 or value[2] != ':':
        return False
    try:
        hour, minute = int(value[:2]), int(value[3:])
    except ValueError:
        return False
    return 0 <= hour <= 23 and 0 <= minute <= 59


def gram_value(amount):
    """'6g' → 6；克数量值（干粉主食按克直记），1~99 的整数克。"""
    if not isinstance(amount, str) or not amount.endswith('g'):
        return None
    try:
        value = int(amount[:-1])
    except ValueError:
        return None
    return value if 1 <= value <= 99 else None


def portion_value(amount):
    """'1.5份' → 1.5；非份量返回 None。"""
    if not isinstance(amount, str) or not amount.endswith('份'):
        return None
    try:
        return float(amount[:-1])
    except ValueError:
        return None


def intake_date(value):
    try:
        parsed = date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        parsed = None
    if parsed is None or parsed.isoformat() != value:
        raise FoodLibraryError('请选择有效日期')
    if parsed > datetime.now(CN_TZ).date():
        raise FoodLibraryError('不能记录未来日期的辅食')
    return value


class FoodEntryStore(FoodLibraryStore):
    def context(self, selected_date):
        selected_date = intake_date(selected_date)
        with self.connect() as connection:
            return self.context_in(connection, selected_date)

    def context_in(self, connection, selected_date):
        categories = [dict(row) for row in connection.execute('SELECT * FROM categories ORDER BY sort_order, id')]
        foods = [dict(row) for row in connection.execute('SELECT * FROM foods ORDER BY id')]
        # 每样食物最近一次进食时刻（按事实：日期+进食时间），供「＋加一个」抽屉排"最近吃过"
        last_eaten = {row['food_id']: row['last_time'] for row in connection.execute(
            'SELECT food_id, MAX(date || \'T\' || eaten_time) AS last_time FROM food_entries GROUP BY food_id'
        )}
        for food in foods:
            food['last_eaten'] = last_eaten.get(food['id'])
            latest = connection.execute(
                'SELECT * FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (food['id'],)
            ).fetchone()
            food.update(status='untouched', round_id=None, eaten_days=0, observe_days=3, position=1)
            if latest is not None:
                dates = {row['date'] for row in connection.execute(
                    'SELECT DISTINCT date FROM food_entries WHERE round_id = ?', (latest['id'],)
                )}
                food.update(
                    status={'active': 'screening', 'normal': 'normal', 'allergic': 'allergic'}[latest['status']],
                    round_id=latest['id'], observe_days=latest['observe_days'], eaten_days=len(dates),
                    position=max(1, len(dates) + (selected_date not in dates)),
                    start_date=latest['start_date'],
                )
        entries = [dict(row) for row in connection.execute(
            'SELECT * FROM food_entries WHERE date = ? ORDER BY id', (selected_date,)
        )]
        # 一笔 = 同日同进食时间的条目组；按时间升序供前端直接渲染
        grouped = {}
        for entry in entries:
            grouped.setdefault(entry['eaten_time'], []).append(entry)
        occasions = [{'time': eaten_time, 'entries': rows} for eaten_time, rows in sorted(grouped.items())]
        row = connection.execute(
            'SELECT revision FROM food_day_versions WHERE date = ?', (selected_date,)).fetchone()
        return {'date': selected_date, 'categories': categories, 'foods': foods, 'entries': entries,
                'occasions': occasions, 'day_revision': row['revision'] if row else 0}

    def latest_entry_time(self):
        """最近一次辅食的进食时刻：按事实（日期+进食时间），补记晚保存不再把"距上一顿"算小。"""
        with self.connect() as connection:
            row = connection.execute(
                "SELECT MAX(date || 'T' || eaten_time || ':00') AS latest FROM food_entries").fetchone()
        return row['latest'] if row else None

    def recent_meal_records(self, since_date):
        """近段日期的辅食按（日期, 进食时间）聚合成首页最近记录条目，一笔一卡。
        序号 ordinal 是同日内按时间排序算出的展示值，永不入库。"""
        with self.connect() as connection:
            rows = connection.execute(
                '''SELECT date, eaten_time, COUNT(*) AS item_count,
                          GROUP_CONCAT(food_name, '、') AS foods
                   FROM food_entries WHERE date >= ?
                   GROUP BY date, eaten_time ORDER BY date DESC, eaten_time ASC''', (since_date,)
            ).fetchall()
        slots = self.meal_slots()
        records = []
        ordinal_by_date = {}
        for row in rows:
            ordinal_by_date[row['date']] = ordinal_by_date.get(row['date'], 0) + 1
            records.append({
                'id': f"food-{row['date']}-{row['eaten_time'].replace(':', '')}",
                'type': 'food',
                'time': f"{row['date']}T{row['eaten_time']}:00",
                'date': row['date'],
                'foods': row['foods'] or '',
                'itemCount': row['item_count'],
                'slot': slot_for_time(slots, row['eaten_time']),
                'ordinal': ordinal_by_date[row['date']],
            })
        return records

    def first_observe_days(self, connection, food_id, day):
        """首次排敏轮次的观察天数：沿用排期块 → 队列设定 → 全局默认，都缺才兜底 3 天。
        只看覆盖「当天」的块：轮次从实际开吃那天起算，不该拿别的日期段的天数。"""
        day_iso = day.isoformat() if isinstance(day, date) else str(day)
        row = connection.execute(
            "SELECT days FROM food_plan_blocks WHERE food_id = ? AND status = 'scheduled' "
            "AND start_date <= ? AND date(start_date, '+' || (days - 1) || ' days') >= ? LIMIT 1",
            (food_id, day_iso, day_iso)).fetchone()
        if row is not None:
            return row['days']
        row = connection.execute(
            'SELECT observe_days FROM food_queue WHERE food_id = ?', (food_id,)).fetchone()
        if row is not None and row['observe_days']:
            return row['observe_days']
        row = connection.execute(
            "SELECT value FROM food_settings WHERE key = 'observe_days_default'").fetchone()
        if row is not None:
            try:
                value = int(json.loads(row['value']))
            except (TypeError, ValueError):
                value = 3
            if 1 <= value <= 14:
                return value
        return 3

    def save_occasion(self, data):
        """按笔替换：ids=被替换的旧条目编号全集（可为空=新记一笔），entries=这笔的新状态。
        改时间/改日期就是挪移——旧行按 id 删除、以新日期新时间重插。"""
        selected_date = intake_date(data.get('date'))
        eaten_time = data.get('time')
        if not valid_time(eaten_time):
            raise FoodLibraryError('请填写这笔的进食时间（HH:MM）')
        revision = data.get('revision')
        if type(revision) is not int or not 0 <= revision < 9223372036854775807:
            raise FoodLibraryError('缺少有效的当日版本，请重新打开表单')
        replace_ids = data.get('ids')
        if not isinstance(replace_ids, list) or len(replace_ids) > 100:
            raise FoodLibraryError('请提交有效的记录编号列表')
        entry_ids = set()
        for identifier in replace_ids:
            if type(identifier) is not int or identifier <= 0 or identifier in entry_ids:
                raise FoodLibraryError('记录编号无效或重复')
            entry_ids.add(identifier)
        entries = data.get('entries')
        if not isinstance(entries, list) or len(entries) > 100:
            raise FoodLibraryError('请提交有效的食物列表，一笔最多 100 种食物')
        identifiers = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise FoodLibraryError('食物记录格式错误')
            food_id = entry.get('food_id')
            if type(food_id) is not int or not 0 < food_id <= 9223372036854775807:
                raise FoodLibraryError('请选择有效食物')
            if food_id in identifiers:
                raise FoodLibraryError('同一笔不能重复添加同一种食物')
            identifiers.add(food_id)
            entry_id = entry.get('id')
            if entry_id is not None:
                if type(entry_id) is not int or entry_id <= 0:
                    raise FoodLibraryError('记录编号无效')
                if entry_id not in entry_ids:
                    raise FoodLibraryError('记录不属于当前这笔，请重新载入', 409)
            if entry.get('amount') not in ALL_AMOUNTS and gram_value(entry.get('amount')) is None:
                raise FoodLibraryError('请为每种食物选择进食量')
            if entry.get('rating') not in (None, '', *RATINGS):
                raise FoodLibraryError('接受度只能是喜欢、一般或拒绝')
            note = entry.get('note', '')
            if not isinstance(note, str) or len(note) > 500:
                raise FoodLibraryError('备注最多 500 个字符')
            try:
                note.encode('utf-8')
            except UnicodeError as error:
                raise FoodLibraryError('备注包含无效字符') from error
            if entry.get('mode', 'keep') not in ('keep', 'start', 'normal', 'retry', 'only'):
                raise FoodLibraryError('请选择有效的排敏记录方式')
        with self.connect() as connection:
            # 来源日：被替换的旧行必须全部存在且同属一个日期（改日期=挪到目标日）
            source_date = selected_date
            previous = {}
            if entry_ids:
                marks = ','.join('?' * len(entry_ids))
                rows = connection.execute(
                    f'SELECT * FROM food_entries WHERE id IN ({marks})', tuple(entry_ids)).fetchall()
                previous = {row['id']: dict(row) for row in rows}
                if len(previous) != len(entry_ids):
                    raise FoodLibraryError('记录已不存在，请重新载入', 409)
                dates = {row['date'] for row in previous.values()}
                if len(dates) != 1:
                    raise FoodLibraryError('这笔跨了多个日期，请重新载入', 409)
                source_date = dates.pop()
            current = connection.execute(
                'SELECT revision FROM food_day_versions WHERE date = ?', (source_date,)).fetchone()
            if revision != (current['revision'] if current else 0):
                raise FoodLibraryError('今天已在其他设备更新，请重新载入后再编辑；当前输入尚未保存', 409)
            now = datetime.now(CN_TZ).isoformat()
            # 按笔替换前，先按旧记录的扣减明细退还批次份数（未变的条目随后会重新扣回，净值为零）
            for old in previous.values():
                self.refund_deduction(connection, old['deduction'])
            prepared = []
            for entry in entries:
                old = previous.get(entry.get('id'))
                food = connection.execute('SELECT * FROM foods WHERE id = ?', (entry['food_id'],)).fetchone()
                unchanged_food = old is not None and old['food_id'] == entry['food_id']
                if food is None and not unchanged_food:
                    raise FoodLibraryError('所选食物已删除，请重新选择', 409)
                round_id = old['round_id'] if unchanged_food else None
                if not unchanged_food:
                    latest = connection.execute(
                        'SELECT * FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (entry['food_id'],)
                    ).fetchone()
                    mode = entry.get('mode', 'keep')
                    if latest is None or latest['status'] == 'allergic':
                        allowed = ('start', 'normal') if latest is None else ('retry', 'only')
                        if mode not in allowed:
                            raise FoodLibraryError('食物排敏状态已变化，请重新载入并确认记录方式', 409)
                        if mode != 'only':
                            status = 'normal' if mode == 'normal' else 'active'
                            days = latest['observe_days'] if latest \
                                else self.first_observe_days(connection, entry['food_id'], selected_date)
                            cursor = connection.execute(
                                '''INSERT INTO food_rounds (food_id, start_date, observe_days, status, created_at)
                                   VALUES (?, ?, ?, ?, ?)''', (entry['food_id'], selected_date, days, status, now)
                            )
                            round_id = cursor.lastrowid if status == 'active' else None
                    elif latest['status'] == 'active':
                        if mode not in ('keep', 'start'):
                            raise FoodLibraryError('食物已在排敏中，请重新载入确认', 409)
                        if selected_date >= latest['start_date']:
                            round_id = latest['id']
                    elif mode not in ('keep', 'normal'):
                        raise FoodLibraryError('食物已标记正常，请重新载入确认', 409)
                # 备餐扣减与克数折算：按笔先退后扣，未变条目同样重扣（净值为零），批次变化时按现状重算
                portion = portion_value(entry['amount'])
                if portion is not None:
                    grams, used = self.deduct_portions(connection, entry['food_id'], portion)
                    deduction = json.dumps(used, ensure_ascii=False) if used else None
                else:
                    gram = gram_value(entry['amount'])
                    grams, deduction = (float(gram), None) if gram is not None else (None, None)
                prepared.append((
                    old['id'] if old else None, selected_date, entry['food_id'],
                    (old['food_name'] if unchanged_food else food['name']), round_id,
                    entry['amount'], entry.get('rating') or None, entry.get('note', '').strip(),
                    old['created_at'] if old else now, grams, deduction,
                    eaten_time,
                ))
            if entry_ids:
                marks = ','.join('?' * len(entry_ids))
                connection.execute(f'DELETE FROM food_entries WHERE id IN ({marks})', tuple(entry_ids))
            connection.executemany(
                '''INSERT INTO food_entries
                   (id, date, food_id, food_name, round_id, amount, rating, note,
                    created_at, grams, deduction, eaten_time)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', prepared
            )
            # 当日版本：来源日与目标日各 +1（同日即一次），乐观锁按日
            for target_date in {source_date, selected_date}:
                existing = connection.execute(
                    'SELECT revision FROM food_day_versions WHERE date = ?', (target_date,)).fetchone()
                connection.execute(
                    '''INSERT INTO food_day_versions (date, revision) VALUES (?, ?)
                       ON CONFLICT(date) DO UPDATE SET revision = excluded.revision''',
                    (target_date, (existing['revision'] if existing else 0) + 1),
                )
            return self.context_in(connection, selected_date)

    # ---------- 备餐批次：按份记录的库存与含量标定 ----------

    def deduct_portions(self, connection, food_id, portions):
        """按 FIFO 从该食物的批次扣份数，返回 (克数, [{batch_id, portions}])；无可用批次则 (None, [])。"""
        if portions <= 0:
            return 0.0, []
        rows = connection.execute(
            'SELECT id, grams_per_portion, portions_left FROM food_prep_batches '
            'WHERE food_id = ? AND portions_left > 0 ORDER BY id', (food_id,)
        ).fetchall()
        if not rows:
            return None, []
        need = portions
        grams = 0.0
        used = []
        for row in rows:
            if need <= 0:
                break
            take = min(row['portions_left'], need)
            connection.execute(
                'UPDATE food_prep_batches SET portions_left = portions_left - ? WHERE id = ?',
                (take, row['id'])
            )
            grams += take * row['grams_per_portion']
            used.append({'batch_id': row['id'], 'portions': take})
            need -= take
        return round(grams, 1), used

    def refund_deduction(self, connection, deduction_json):
        """整餐重写前按旧明细退还份数；退还量封顶在批次总份数，防漂移越积越多。"""
        if not deduction_json:
            return
        try:
            items = json.loads(deduction_json)
        except (TypeError, ValueError):
            return
        if not isinstance(items, list):
            return
        for item in items:
            if (isinstance(item, dict) and type(item.get('batch_id')) is int
                    and type(item.get('portions')) in (int, float) and item['portions'] > 0):
                connection.execute(
                    'UPDATE food_prep_batches SET portions_left = MIN(portions_left + ?, portions_total) '
                    'WHERE id = ?', (item['portions'], item['batch_id'])
                )

    def _prep_overview_in(self, connection, selected_date):
        rows = connection.execute('''
            SELECT e.amount, e.grams, f.name AS food_name, c.name AS category_name
            FROM food_entries e
            JOIN foods f ON f.id = e.food_id
            LEFT JOIN categories c ON c.id = f.category_id
            WHERE e.date = ?
        ''', (selected_date,)).fetchall()
        category_group = {name: key for key, names in MACRO_GROUPS.items() for name in names}
        groups = {}
        for row in rows:
            key = category_group.get(row['category_name'] or '')
            if key is None:
                continue
            group = groups.setdefault(key, {
                'key': key, 'emoji': MACRO_EMOJI[key],
                'grams': 0.0, 'portions': 0.0, 'spoons': 0.0, 'foods': [],
            })
            if row['food_name'] not in group['foods']:
                group['foods'].append(row['food_name'])
            portion = portion_value(row['amount'])
            gram = gram_value(row['amount'])
            if gram is not None:
                group['grams'] += gram
            elif portion is not None:
                if row['grams']:
                    group['grams'] += row['grams']
                else:
                    group['portions'] += portion
            elif row['grams']:
                group['grams'] += row['grams']
            else:
                group['spoons'] += SPOON_EQUIV.get(row['amount'], 0)
        for group in groups.values():
            group['grams'] = round(group['grams'], 1)
            group['portions'] = round(group['portions'], 1)
            group['spoons'] = round(group['spoons'], 1)
        batches = []
        for row in connection.execute('''
            SELECT b.*, f.name AS food_name, c.name AS category_name, c.emoji AS category_emoji
            FROM food_prep_batches b
            JOIN foods f ON f.id = b.food_id
            LEFT JOIN categories c ON c.id = f.category_id
            ORDER BY b.id DESC
        '''):
            daily, days_left = self._forecast_food(connection, row['food_id'], row['portions_left'])
            batches.append({
                'id': row['id'], 'food_id': row['food_id'], 'food_name': row['food_name'],
                'category_name': row['category_name'], 'emoji': row['category_emoji'] or '🧊',
                'portions_left': row['portions_left'], 'portions_total': row['portions_total'],
                'grams_per_portion': row['grams_per_portion'],
                'low': 0 < row['portions_left'] <= 1,
                'exhausted': row['portions_left'] == 0,
                'daily': daily, 'days_left': days_left,
            })
        return {'date': selected_date, 'today': {'groups': [groups[key] for key in MACRO_GROUPS if key in groups]},
                'batches': batches}

    def _forecast_food(self, connection, food_id, remaining):
        """按计划从明天起逐日累计需求，返回 (明日计划份数, 余量够吃的整天数)。
        days_left=None 表示未来14天都够；daily=None 表示计划里没排这个食物。"""
        tomorrow = (datetime.now(CN_TZ).date() + timedelta(days=1)).isoformat()
        horizon = (datetime.now(CN_TZ).date() + timedelta(days=14)).isoformat()
        plans = [dict(row) for row in connection.execute(
            'SELECT start_date, days, meal, portions FROM food_normal_plans '
            'WHERE food_id = ? AND portions IS NOT NULL AND start_date <= ?', (food_id, horizon))]
        overrides = {}
        for row in connection.execute(
                'SELECT date, meal, portions FROM food_menu_overrides '
                'WHERE food_id = ? AND date >= ? AND date <= ?', (food_id, tomorrow, horizon)):
            overrides[row['date']] = dict(row)

        def meals_of(value):
            parts = str(value or '').split(',')
            if 'all' in parts or 'both' in parts:
                parts = ['lunch', 'dinner']
            return [part for part in parts if part in MEALS]

        def stored(value):
            if isinstance(value, str) and value.startswith('{'):
                try:
                    return json.loads(value)
                except (ValueError, TypeError):
                    return None
            return value

        def per_meal(portions, meal, fallback):
            if portions is None:
                return fallback
            portions = stored(portions)
            if isinstance(portions, dict):
                return portions.get(meal) if portions.get(meal) is not None else fallback
            return portions

        used = 0.0
        days_left = None
        daily = None
        day_date = date.fromisoformat(tomorrow)
        while day_date.isoformat() <= horizon:
            key = day_date.isoformat()
            need = 0.0
            override = overrides.get(key)
            if override is not None and override['meal'] == 'none':
                need = 0.0   # 这天不吃：当天计划被覆盖掉
            else:
                for plan in plans:
                    start = date.fromisoformat(plan['start_date'])
                    end = start + timedelta(days=plan['days'] - 1)
                    if not start <= day_date <= end:
                        continue
                    if override is not None:
                        today_meals = meals_of(override['meal'])
                        ov_portions = override['portions']
                    else:
                        today_meals = meals_of(plan['meal'])
                        ov_portions = None
                    need += sum(per_meal(ov_portions, meal, plan['portions']) or 0
                                for meal in today_meals)
                    break
                else:
                    if override is not None and override['portions'] is not None:
                        need += sum(per_meal(override['portions'], meal, None) or 0
                                    for meal in meals_of(override['meal']))
            if key == tomorrow:
                daily = round(need, 1) if need else None
            if used + need > remaining + 1e-9:
                days_left = (day_date - date.fromisoformat(tomorrow)).days
                break
            used += need
            day_date += timedelta(days=1)
        return daily, days_left

    def prep_overview(self, selected_date):
        selected_date = intake_date(selected_date)
        with self.connect() as connection:
            return self._prep_overview_in(connection, selected_date)

    def add_prep_batch(self, data):
        food_id = data.get('food_id')
        if type(food_id) is not int:
            raise FoodLibraryError('请选择有效食物')
        portions = data.get('portions')
        if type(portions) is not int or not 1 <= portions <= 200:
            raise FoodLibraryError('份数只能是 1 到 200')
        note = data.get('note', '')
        if not isinstance(note, str) or len(note) > 100:
            raise FoodLibraryError('备注最多 100 个字符')
        with self.connect() as connection:
            food = connection.execute('SELECT name FROM foods WHERE id = ?', (food_id,)).fetchone()
            if food is None:
                raise FoodLibraryError('该食物已不存在，请刷新后重试', 404)
            latest = connection.execute(
                'SELECT status FROM food_rounds WHERE food_id = ? ORDER BY id DESC LIMIT 1', (food_id,)
            ).fetchone()
            if latest is not None and latest['status'] == 'allergic':
                raise FoodLibraryError(f'「{food["name"]}」是过敏食物，不能备餐', 409)
            raw_grams = data.get('raw_grams')
            grams_per_portion = data.get('grams_per_portion')
            if type(raw_grams) in (int, float) and raw_grams > 0:
                grams_per_portion = round(raw_grams / portions, 2)
            elif not (type(grams_per_portion) in (int, float) and grams_per_portion > 0):
                grams_per_portion = 0
            connection.execute(
                'INSERT INTO food_prep_batches '
                '(food_id, portions_total, portions_left, grams_per_portion, note, created_at) '
                'VALUES (?, ?, ?, ?, ?, ?)',
                (food_id, portions, portions, grams_per_portion, note.strip(),
                 datetime.now(CN_TZ).isoformat())
            )
            return self._prep_overview_in(connection, datetime.now(CN_TZ).date().isoformat())

    def update_prep_batch(self, identifier, data):
        with self.connect() as connection:
            row = connection.execute(
                'SELECT * FROM food_prep_batches WHERE id = ?', (identifier,)).fetchone()
            if row is None:
                raise FoodLibraryError('备餐批次已不存在，请刷新后重试', 404)
            if 'portions_left' not in data:
                raise FoodLibraryError('没有需要修改的内容')
            value = data.get('portions_left')
            if type(value) is not int or not 0 <= value <= row['portions_total']:
                raise FoodLibraryError(f'剩余份数只能在 0 到 {row["portions_total"]} 之间')
            connection.execute(
                'UPDATE food_prep_batches SET portions_left = ? WHERE id = ?', (value, identifier))
            return self._prep_overview_in(connection, datetime.now(CN_TZ).date().isoformat())

    def delete_prep_batch(self, identifier):
        with self.connect() as connection:
            if connection.execute(
                    'SELECT 1 FROM food_prep_batches WHERE id = ?', (identifier,)).fetchone() is None:
                raise FoodLibraryError('备餐批次已不存在，请刷新后重试', 404)
            connection.execute('DELETE FROM food_prep_batches WHERE id = ?', (identifier,))
            return self._prep_overview_in(connection, datetime.now(CN_TZ).date().isoformat())


def register_food_entries(app, data_dir):
    store = FoodEntryStore(data_dir)
    app.extensions['food_entry_store'] = store
    blueprint = Blueprint('food_entries', __name__, url_prefix='/api')

    @blueprint.errorhandler(FoodLibraryError)
    def invalid_input(error):
        return jsonify({'success': False, 'error': str(error)}), error.status

    @blueprint.errorhandler(sqlite3.Error)
    @blueprint.errorhandler(OSError)
    def unavailable(error):
        current_app.logger.error('Food entries unavailable: %s', error)
        return jsonify({'success': False, 'error': '辅食记录暂时无法读写，请稍后重试'}), 503

    @blueprint.get('/entries')
    def get_entries():
        selected_date = request.args.get('date', datetime.now(CN_TZ).date().isoformat())
        return jsonify(store.context(selected_date))

    @blueprint.post('/meals')
    def save_meal():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise FoodLibraryError('请提交有效的 JSON 对象')
        result = store.save_occasion(data)
        return jsonify({'success': True, **result})

    @blueprint.get('/prep/overview')
    def prep_overview():
        selected_date = request.args.get('date', datetime.now(CN_TZ).date().isoformat())
        return jsonify(store.prep_overview(selected_date))

    @blueprint.post('/prep/batches')
    def add_prep_batch():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise FoodLibraryError('请提交有效的 JSON 对象')
        return jsonify({'success': True, **store.add_prep_batch(data)})

    @blueprint.route('/prep/batches/<int:batch_id>', methods=['PUT', 'DELETE'])
    def change_prep_batch(batch_id):
        if request.method == 'PUT':
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                raise FoodLibraryError('请提交有效的 JSON 对象')
            return jsonify({'success': True, **store.update_prep_batch(batch_id, data)})
        return jsonify({'success': True, **store.delete_prep_batch(batch_id)})

    app.register_blueprint(blueprint)
