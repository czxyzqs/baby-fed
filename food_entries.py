"""Whole-meal food intake records stored alongside the food library."""

from datetime import date, datetime, timedelta, timezone
import sqlite3

from flask import Blueprint, current_app, jsonify, request

from food_library import FoodLibraryError, FoodLibraryStore


MEALS = ('breakfast', 'lunch', 'snack', 'dinner')
AMOUNTS = ('一勺尖', '一勺', '两勺', '三勺', '半碗', '一碗')
RATINGS = ('喜欢', '一般', '拒绝')
CN_TZ = timezone(timedelta(hours=8))


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
        for food in foods:
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
        revisions = {meal: 0 for meal in MEALS}
        revisions.update({row['meal']: row['revision'] for row in connection.execute(
            'SELECT meal, revision FROM food_meal_versions WHERE date = ?', (selected_date,)
        )})
        return {'date': selected_date, 'categories': categories, 'foods': foods, 'entries': entries, 'revisions': revisions}

    def save_meal(self, data):
        selected_date = intake_date(data.get('date'))
        meal = data.get('meal')
        if meal not in MEALS:
            raise FoodLibraryError('请选择早餐、午餐、下午茶或晚餐')
        revision = data.get('revision')
        if type(revision) is not int or not 0 <= revision < 9223372036854775807:
            raise FoodLibraryError('缺少有效的餐次版本，请重新打开表单')
        entries = data.get('entries')
        if not isinstance(entries, list) or len(entries) > 100:
            raise FoodLibraryError('请提交有效的食物列表，一餐最多 100 种食物')
        identifiers = set()
        entry_ids = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise FoodLibraryError('食物记录格式错误')
            food_id = entry.get('food_id')
            if type(food_id) is not int or not 0 < food_id <= 9223372036854775807:
                raise FoodLibraryError('请选择有效食物')
            if food_id in identifiers:
                raise FoodLibraryError('同一餐不能重复添加同一种食物')
            identifiers.add(food_id)
            entry_id = entry.get('id')
            if entry_id is not None:
                if type(entry_id) is not int or entry_id <= 0 or entry_id in entry_ids:
                    raise FoodLibraryError('记录编号无效或重复')
                entry_ids.add(entry_id)
            if entry.get('amount') not in AMOUNTS:
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
            current = connection.execute(
                'SELECT revision FROM food_meal_versions WHERE date = ? AND meal = ?', (selected_date, meal)
            ).fetchone()
            if revision != (current['revision'] if current else 0):
                raise FoodLibraryError('这餐已在其他设备更新，请重新载入后再编辑；当前输入尚未保存', 409)
            previous = {row['id']: dict(row) for row in connection.execute(
                'SELECT * FROM food_entries WHERE date = ? AND meal = ?', (selected_date, meal)
            )}
            if not entry_ids.issubset(previous):
                raise FoodLibraryError('记录不属于当前餐次，请重新载入', 409)
            now = datetime.now(CN_TZ).isoformat()
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
                            days = latest['observe_days'] if latest else 3
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
                prepared.append((
                    old['id'] if old else None, selected_date, meal, entry['food_id'],
                    old['food_name'] if unchanged_food else food['name'], round_id,
                    entry['amount'], entry.get('rating') or None, entry.get('note', '').strip(),
                    old['created_at'] if old else now,
                ))
            connection.execute('DELETE FROM food_entries WHERE date = ? AND meal = ?', (selected_date, meal))
            connection.executemany(
                '''INSERT INTO food_entries
                   (id, date, meal, food_id, food_name, round_id, amount, rating, note, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', prepared
            )
            connection.execute(
                '''INSERT INTO food_meal_versions (date, meal, revision) VALUES (?, ?, ?)
                   ON CONFLICT(date, meal) DO UPDATE SET revision = excluded.revision''',
                (selected_date, meal, revision + 1),
            )
            return self.context_in(connection, selected_date)


def register_food_entries(app, data_dir):
    store = FoodEntryStore(data_dir)
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
        result = store.save_meal(data)
        return jsonify({'success': True, **result})

    app.register_blueprint(blueprint)
