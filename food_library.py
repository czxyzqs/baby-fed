"""Persistent food and category management, separate from feeding records."""

from contextlib import contextmanager
from pathlib import Path
import json
import sqlite3

from flask import Blueprint, current_app, jsonify, request


PRESET_CATEGORIES = (
    ('谷薯类', '🌾', False, ('婴儿米粉', '大米', '小米', '燕麦', '土豆', '红薯')),
    ('蔬菜类', '🥦', False, ('胡萝卜', '南瓜', '西兰花', '菠菜', '冬瓜', '山药')),
    ('水果类', '🍎', False, ('苹果', '香蕉', '梨', '蓝莓', '猕猴桃')),
    ('蛋类', '🥚', True, ('蛋黄', '全蛋', '鹌鹑蛋')),
    ('鱼虾贝类', '🐟', True, ('三文鱼', '鳕鱼', '鲈鱼', '虾')),
    ('畜禽肉类', '🥩', False, ('猪肉', '牛肉', '鸡肉', '羊肉')),
    ('肝类', '🍖', False, ('猪肝', '鸡肝')),
    ('豆及豆制品类', '🫘', True, ('豆腐', '黄豆', '豆浆')),
    ('奶及奶制品类', '🥛', True, ('原味酸奶', '奶酪')),
    ('坚果种子类', '🥜', True, ('花生酱', '芝麻酱', '核桃酱')),
    ('油脂类', '🫒', False, ('菜籽油', '橄榄油', '核桃油')),
)

# 常见辅食的植物科属（科名 -> 同科食物）；用于辅食库「按科属」展示和新增食物的自动归科
FAMILY_PRESETS = {
    '十字花科': ('西兰花', '菜花', '花菜', '卷心菜', '圆白菜', '包菜', '芥蓝', '萝卜', '白萝卜', '油菜',
               '白菜', '大白菜', '娃娃菜', '羽衣甘蓝', '紫甘蓝', '芥菜', '大头菜', '苤蓝', '菜籽油'),
    '伞形科': ('胡萝卜', '芹菜', '香菜', '茴香'),
    '苋科': ('菠菜', '苋菜', '红苋菜', '藜麦'),
    '菊科': ('生菜', '油麦菜', '莴笋', '菊苣', '茼蒿'),
    '茄科': ('番茄', '西红柿', '辣椒', '彩椒', '青椒', '土豆', '马铃薯', '茄子'),
    '葫芦科': ('南瓜', '冬瓜', '黄瓜', '丝瓜', '苦瓜', '西葫芦', '西瓜', '甜瓜', '哈密瓜'),
    '豆科': ('菜豆', '四季豆', '豇豆', '刀豆', '毛豆', '蚕豆', '扁豆', '荷兰豆', '豌豆', '绿豆', '红豆',
            '黄豆', '大豆', '豆腐', '豆浆', '豆芽', '花生', '花生酱', '鹰嘴豆'),
    '百合科': ('洋葱', '大葱', '小葱', '香葱', '韭菜', '大蒜', '蒜', '蒜苗', '韭黄'),
    '禾本科': ('大米', '稻米', '小米', '燕麦', '婴儿米粉', '玉米', '小麦', '面粉', '面条'),
    '锦葵科': ('秋葵',),
    '薯蓣科': ('山药',),
    '旋花科': ('红薯', '地瓜', '空心菜'),
    '天南星科': ('芋头',),
    '蔷薇科': ('苹果', '梨', '山楂', '海棠', '桃', '桃子', '杏', '李', '李子', '樱桃', '草莓', '枇杷', '梅'),
    '芸香科': ('橙子', '甜橙', '橘子', '柑橘', '柚子', '柠檬'),
    '葡萄科': ('葡萄',),
    '猕猴桃科': ('猕猴桃',),
    '杜鹃花科': ('蓝莓',),
    '芭蕉科': ('香蕉',),
    '凤梨科': ('菠萝', '凤梨'),
    '仙人掌科': ('火龙果',),
    '番木瓜科': ('木瓜',),
    '柿科': ('柿子',),
    '石榴科': ('石榴',),
    '鼠李科': ('枣', '冬枣'),
    '无患子科': ('荔枝', '龙眼', '桂圆'),
    '漆树科': ('芒果',),
    '樟科': ('牛油果',),
    '西番莲科': ('百香果',),
    '棕榈科': ('椰子',),
    '胡桃科': ('核桃', '核桃酱', '核桃油'),
    '胡麻科': ('芝麻', '芝麻酱'),
    '亚麻科': ('亚麻籽', '亚麻籽油'),
    '木樨科': ('橄榄油',),
    '桦木科': ('榛子',),
    '壳斗科': ('板栗', '栗子'),
    '松科': ('松子',),
}

FOOD_FAMILY = {food: family for family, foods in FAMILY_PRESETS.items() for food in foods}

# 餐次槽：内部 key 沿用四餐代号（用户不可见），显示名与开始时间由 food_settings.meal_slots 配置。
# 记录侧不存餐次，槽只活在计划侧；"时间落槽"是记录与计划的唯一匹配方式。
SLOT_LABELS = {'breakfast': '早餐', 'lunch': '上午餐', 'snack': '下午茶', 'dinner': '下午餐'}
DEFAULT_SLOT_STARTS = {'breakfast': '06:30', 'lunch': '11:00', 'snack': '14:30', 'dinner': '17:30'}


def hhmm_to_minutes(value):
    """'HH:MM' → 当天分钟数；非法返回 None。"""
    if not isinstance(value, str) or len(value) != 5 or value[2] != ':':
        return None
    try:
        hour, minute = int(value[:2]), int(value[3:])
    except ValueError:
        return None
    if 0 <= hour <= 23 and 0 <= minute <= 59:
        return hour * 60 + minute
    return None


def slot_for_time(slots, hhmm):
    """按槽起始时间把时刻归槽；槽全天无缝覆盖，任何时刻必有归属。"""
    minutes = hhmm_to_minutes(hhmm)
    if minutes is None:
        return slots[-1]['key']
    result = slots[0]['key']
    for slot in slots[1:]:
        if minutes >= slot['start']:
            result = slot['key']
        else:
            break
    return result


def normalize_meal_slots(data):
    """校验前端提交的餐次槽配置，返回可存入 food_settings 的 dict。"""
    if not isinstance(data, dict):
        raise FoodLibraryError('餐次配置格式错误')
    active = data.get('active')
    if not isinstance(active, list) or not active:
        raise FoodLibraryError('至少启用一个餐次')
    ordered = [key for key in FoodLibraryStore.ACTIVE_MEALS if key in active]
    if len(ordered) != len(set(active)):
        raise FoodLibraryError('包含未知或重复的餐次')
    starts = data.get('starts')
    if not isinstance(starts, dict):
        starts = {}
    result_starts, previous = {}, -1
    for index, key in enumerate(ordered):
        if index == 0:
            continue   # 首槽从 0 点起，无需起点
        value = starts.get(key, DEFAULT_SLOT_STARTS[key])
        minutes = hhmm_to_minutes(value)
        if minutes is None:
            raise FoodLibraryError(f'{SLOT_LABELS[key]}的开始时间应为 HH:MM')
        if minutes <= previous:
            raise FoodLibraryError('后一个餐次的开始时间需要晚于前一个')
        result_starts[key] = value
        previous = minutes
    return {'active': ordered, 'starts': result_starts}


class FoodLibraryError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def required_text(data, key, label, maximum):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise FoodLibraryError(f'请填写{label}')
    value = value.strip()
    if len(value) > maximum:
        raise FoodLibraryError(f'{label}最多 {maximum} 个字符')
    try:
        value.encode('utf-8')
    except UnicodeError as error:
        raise FoodLibraryError(f'{label}包含无效字符') from error
    if any(ord(character) < 32 for character in value):
        raise FoodLibraryError(f'{label}不能包含控制字符')
    return value


class FoodLibraryStore:
    # 槽位全集（内部代号）；启用集与各槽开始时间存 food_settings.meal_slots
    ACTIVE_MEALS = ('breakfast', 'lunch', 'snack', 'dinner')

    def __init__(self, data_dir):
        self.path = Path(data_dir) / 'baby-food.db'

    def get_active_meals(self, connection):
        """旧版「每天展示哪几餐」配置；仅作 meal_slots 缺失时的回退。"""
        row = connection.execute("SELECT value FROM food_settings WHERE key = 'active_meals'").fetchone()
        if row is not None:
            try:
                value = json.loads(row['value'])
            except (TypeError, ValueError):
                value = None
            if isinstance(value, list) and value:
                ordered = [meal for meal in self.ACTIVE_MEALS if meal in value]
                if ordered:
                    return ordered
        return list(self.ACTIVE_MEALS)

    def get_meal_slots(self, connection):
        """当前启用的餐次槽（按天序）：[{key, label, start(分钟)}]，首槽固定 0 点。
        配置无效时逐级回退 active_meals → 全集+默认起点，读侧永远兜底出可用槽。"""
        active, starts = None, None
        row = connection.execute("SELECT value FROM food_settings WHERE key = 'meal_slots'").fetchone()
        if row is not None:
            try:
                value = json.loads(row['value'])
            except (TypeError, ValueError):
                value = None
            if isinstance(value, dict):
                active, starts = value.get('active'), value.get('starts')
        if not isinstance(active, list) or not active:
            active = self.get_active_meals(connection)
            starts = None
        ordered = [key for key in self.ACTIVE_MEALS if key in active]
        if len(ordered) != len(set(active)):
            ordered, starts = list(self.ACTIVE_MEALS), None
        slots, previous = [], 0
        for index, key in enumerate(ordered):
            start = 0
            if index > 0:
                candidate = DEFAULT_SLOT_STARTS[key]
                if isinstance(starts, dict) and isinstance(starts.get(key), str):
                    candidate = starts[key]
                minutes = hhmm_to_minutes(candidate)
                if minutes is None or minutes <= previous:
                    minutes = previous + 1   # 保底顺延，保证槽全天无缝且严格递增
                start = minutes
            slots.append({'key': key, 'label': SLOT_LABELS[key], 'start': start})
            previous = start
        return slots

    def active_meals(self):
        with self.connect() as connection:
            return self.get_active_meals(connection)

    def meal_slots(self):
        with self.connect() as connection:
            return self.get_meal_slots(connection)

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute('PRAGMA foreign_keys = ON')
            connection.execute('BEGIN IMMEDIATE')
            version = connection.execute('PRAGMA user_version').fetchone()[0]
            if version == 0:
                connection.execute('''CREATE TABLE categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    emoji TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    is_high_allergen INTEGER NOT NULL DEFAULT 0
                )''')
                connection.execute('''CREATE TABLE foods (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT
                )''')
                connection.execute('CREATE INDEX foods_category_id ON foods(category_id)')
                for position, (name, emoji, allergen, foods) in enumerate(PRESET_CATEGORIES):
                    category = connection.execute(
                        'INSERT INTO categories (name, emoji, sort_order, is_high_allergen) VALUES (?, ?, ?, ?)',
                        (name, emoji, position, allergen),
                    )
                    connection.executemany(
                        'INSERT INTO foods (name, category_id) VALUES (?, ?)',
                        [(food, category.lastrowid) for food in foods],
                    )
                connection.execute('PRAGMA user_version = 1')
                version = 1
            if version == 1:
                connection.execute('''CREATE TABLE food_rounds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    food_id INTEGER NOT NULL,
                    start_date TEXT NOT NULL,
                    observe_days INTEGER NOT NULL DEFAULT 3,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )''')
                connection.execute('CREATE INDEX food_rounds_food ON food_rounds(food_id, id)')
                connection.execute('''CREATE TABLE food_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT NOT NULL,
                    meal TEXT NOT NULL,
                    food_id INTEGER NOT NULL,
                    food_name TEXT NOT NULL,
                    round_id INTEGER REFERENCES food_rounds(id),
                    amount TEXT NOT NULL,
                    rating TEXT,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    UNIQUE(date, meal, food_id)
                )''')
                connection.execute('''CREATE TABLE food_meal_versions (
                    date TEXT NOT NULL,
                    meal TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(date, meal)
                )''')
                connection.execute('CREATE INDEX food_entries_round_date ON food_entries(round_id, date)')
                connection.execute('PRAGMA user_version = 2')
                version = 2
            if version == 2:
                connection.execute('''CREATE TABLE food_reactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    round_id INTEGER NOT NULL REFERENCES food_rounds(id),
                    date TEXT NOT NULL,
                    symptoms TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                )''')
                connection.execute('CREATE INDEX food_reactions_round ON food_reactions(round_id, date)')
                connection.execute('''CREATE TABLE food_plan_blocks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
                    start_date TEXT NOT NULL,
                    days INTEGER NOT NULL,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'scheduled',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )''')
                connection.execute('CREATE INDEX food_plan_blocks_date ON food_plan_blocks(start_date)')
                connection.execute('''CREATE TABLE food_pauses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    start_date TEXT NOT NULL,
                    end_date TEXT NOT NULL,
                    reason TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL DEFAULT 'manual',
                    created_at TEXT NOT NULL
                )''')
                connection.execute('''CREATE TABLE food_normal_plans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
                    start_date TEXT NOT NULL,
                    days INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                )''')
                connection.execute('''CREATE TABLE food_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    food_id INTEGER NOT NULL UNIQUE REFERENCES foods(id) ON DELETE CASCADE,
                    sort_order INTEGER NOT NULL,
                    observe_days INTEGER,
                    created_at TEXT NOT NULL
                )''')
                connection.execute('CREATE INDEX food_queue_order ON food_queue(sort_order, id)')
                connection.execute('''CREATE TABLE food_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )''')
                connection.execute('PRAGMA user_version = 3')
                version = 3
            elif version not in (3, 4, 5, 6, 7, 8, 9):
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            if version == 3:
                connection.execute('ALTER TABLE foods ADD COLUMN family TEXT')
                for food, family in FOOD_FAMILY.items():
                    connection.execute(
                        'UPDATE foods SET family = ? WHERE name = ? AND family IS NULL', (family, food))
                connection.execute('PRAGMA user_version = 4')
                version = 4
            elif version not in (3, 4, 5, 6, 7, 8, 9):
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            if version == 4:
                # 餐次规划：排敏块默认午餐，常规计划默认两餐都吃；当日覆盖支持临时调整
                connection.execute("ALTER TABLE food_plan_blocks ADD COLUMN meal TEXT NOT NULL DEFAULT 'lunch'")
                connection.execute("ALTER TABLE food_normal_plans ADD COLUMN meal TEXT NOT NULL DEFAULT 'all'")
                connection.execute('''CREATE TABLE food_menu_overrides (
                    date TEXT NOT NULL,
                    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
                    meal TEXT NOT NULL,
                    PRIMARY KEY (date, food_id)
                )''')
                connection.execute('PRAGMA user_version = 5')
                version = 5
            elif version not in (4, 5, 6, 7, 8, 9):
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            if version == 5:
                # 备餐批次：按份记录摄入（份×每份含量折算克数）与库存扣减
                connection.execute('''CREATE TABLE food_prep_batches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
                    portions_total INTEGER NOT NULL,
                    portions_left INTEGER NOT NULL,
                    grams_per_portion REAL NOT NULL DEFAULT 0,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                )''')
                connection.execute('CREATE INDEX food_prep_batches_food ON food_prep_batches(food_id, id)')
                connection.execute('ALTER TABLE food_entries ADD COLUMN grams REAL')
                connection.execute('ALTER TABLE food_entries ADD COLUMN deduction TEXT')
                connection.execute('PRAGMA user_version = 6')
                version = 6
            elif version not in (5, 6, 7, 8, 9):
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            if version == 6:
                # 规划份数：计划/当日覆盖带"每餐份数"，用于记录预填与库存预测
                connection.execute('ALTER TABLE food_normal_plans ADD COLUMN portions REAL')
                connection.execute('ALTER TABLE food_menu_overrides ADD COLUMN portions REAL')
                connection.execute('PRAGMA user_version = 7')
                version = 7
            elif version not in (6, 7, 8, 9):
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            if version == 7:
                # 精确进食时间：晚记的可改回实际吃的时间（HH:MM）
                connection.execute('ALTER TABLE food_entries ADD COLUMN eaten_time TEXT')
                connection.execute('PRAGMA user_version = 8')
                version = 8
            elif version not in (8, 9):
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            if version == 8:
                # 记录去餐次化：事实=日期+时间，"一笔"=同日同进食时间的条目组；
                # meal 列删除（读取方全部改为按时间落槽推导），判重约束换成 (date, eaten_time, food_id)
                connection.execute(
                    "UPDATE food_entries SET eaten_time = substr(created_at, 12, 5) "
                    "WHERE eaten_time IS NULL OR eaten_time = ''")
                connection.execute('''CREATE TABLE food_entries_v9 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT NOT NULL,
                    food_id INTEGER NOT NULL,
                    food_name TEXT NOT NULL,
                    round_id INTEGER REFERENCES food_rounds(id),
                    amount TEXT NOT NULL,
                    rating TEXT,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    grams REAL,
                    deduction TEXT,
                    eaten_time TEXT NOT NULL,
                    UNIQUE(date, eaten_time, food_id)
                )''')
                connection.execute('''INSERT OR IGNORE INTO food_entries_v9
                    (id, date, food_id, food_name, round_id, amount, rating, note,
                     created_at, grams, deduction, eaten_time)
                    SELECT id, date, food_id, food_name, round_id, amount, rating, note,
                           created_at, grams, deduction, eaten_time
                    FROM food_entries ORDER BY id''')
                connection.execute('DROP TABLE food_entries')
                connection.execute('ALTER TABLE food_entries_v9 RENAME TO food_entries')
                connection.execute('CREATE INDEX food_entries_round_date ON food_entries(round_id, date)')
                # 乐观锁从 (date, meal) 收敛到按日
                connection.execute('''CREATE TABLE food_day_versions (
                    date TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL DEFAULT 0
                )''')
                connection.execute('''INSERT INTO food_day_versions (date, revision)
                    SELECT date, MAX(revision) FROM food_meal_versions GROUP BY date''')
                connection.execute('DROP TABLE food_meal_versions')
                # 餐次槽配置：活跃集沿用 active_meals；恰好上午/下午双槽时直达 12 点分界
                active = self.get_active_meals(connection)
                if active == ['lunch', 'dinner']:
                    starts = {'dinner': '12:00'}
                else:
                    starts = {key: DEFAULT_SLOT_STARTS[key] for key in active[1:]}
                connection.execute(
                    'INSERT OR REPLACE INTO food_settings (key, value) VALUES (?, ?)',
                    ('meal_slots', json.dumps({'active': active, 'starts': starts}, ensure_ascii=False)))
                connection.execute('PRAGMA user_version = 9')
                version = 9
            elif version != 9:
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def snapshot(self):
        with self.connect() as connection:
            categories = [dict(row) for row in connection.execute(
                'SELECT * FROM categories ORDER BY sort_order, id'
            )]
            for category in categories:
                category['is_high_allergen'] = bool(category['is_high_allergen'])
            foods = [dict(row) for row in connection.execute('SELECT * FROM foods ORDER BY id')]
            return {'categories': categories, 'foods': foods}

    def require_item(self, connection, kind, identifier):
        if type(identifier) is not int or not 0 < identifier <= 9223372036854775807:
            raise FoodLibraryError('无效的品类或食物编号', 404)
        query = 'SELECT id FROM categories WHERE id = ?' if kind == 'category' else 'SELECT id FROM foods WHERE id = ?'
        if connection.execute(query, (identifier,)).fetchone() is None:
            label = '品类' if kind == 'category' else '食物'
            raise FoodLibraryError(f'该{label}已不存在，请刷新后重试', 404)

    def save_category(self, data, identifier=None):
        name = required_text(data, 'name', '品类名称', 30)
        emoji = required_text(data, 'emoji', '品类图标', 16)
        allergen = data.get('is_high_allergen', False)
        if not isinstance(allergen, bool):
            raise FoodLibraryError('高致敏标记必须为布尔值')
        with self.connect() as connection:
            if identifier is not None:
                self.require_item(connection, 'category', identifier)
            elif connection.execute('SELECT COUNT(*) FROM categories').fetchone()[0] >= 20:
                raise FoodLibraryError('品类最多支持 20 个')
            duplicate = connection.execute('SELECT id FROM categories WHERE name = ?', (name,)).fetchone()
            if duplicate is not None and duplicate['id'] != identifier:
                raise FoodLibraryError('已存在同名品类', 409)
            if identifier is None:
                cursor = connection.execute(
                    '''INSERT INTO categories (name, emoji, sort_order, is_high_allergen)
                       VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories), ?)''',
                    (name, emoji, allergen),
                )
                return cursor.lastrowid
            connection.execute(
                'UPDATE categories SET name = ?, emoji = ?, is_high_allergen = ? WHERE id = ?',
                (name, emoji, allergen, identifier),
            )
            return identifier

    def delete_category(self, identifier):
        with self.connect() as connection:
            self.require_item(connection, 'category', identifier)
            if connection.execute('SELECT 1 FROM foods WHERE category_id = ? LIMIT 1', (identifier,)).fetchone():
                raise FoodLibraryError('该品类还有食物，请先转移或删除食物', 409)
            connection.execute('DELETE FROM categories WHERE id = ?', (identifier,))

    def save_food(self, data, identifier=None):
        name = required_text(data, 'name', '食物名称', 50)
        category_id = data.get('category_id')
        if type(category_id) is not int or not 0 < category_id <= 9223372036854775807:
            raise FoodLibraryError('请选择有效的食物品类')
        family = data.get('family')
        if family is not None:
            if not isinstance(family, str) or len(family.strip()) > 20:
                raise FoodLibraryError('科属最多 20 个字符')
            family = family.strip() or None
        if family is None:
            family = FOOD_FAMILY.get(name)
        with self.connect() as connection:
            self.require_item(connection, 'category', category_id)
            if identifier is not None:
                self.require_item(connection, 'food', identifier)
            duplicate = connection.execute('SELECT id FROM foods WHERE name = ?', (name,)).fetchone()
            if duplicate is not None and duplicate['id'] != identifier:
                raise FoodLibraryError('已存在同名食物，请搜索后编辑', 409)
            if identifier is None:
                cursor = connection.execute(
                    'INSERT INTO foods (name, category_id, family) VALUES (?, ?, ?)', (name, category_id, family))
                return cursor.lastrowid
            connection.execute(
                'UPDATE foods SET name = ?, category_id = ?, family = ? WHERE id = ?',
                (name, category_id, family, identifier))
            return identifier

    def delete_food(self, identifier):
        with self.connect() as connection:
            self.require_item(connection, 'food', identifier)
            connection.execute('DELETE FROM foods WHERE id = ?', (identifier,))


def register_food_library(app, data_dir):
    store = FoodLibraryStore(data_dir)
    blueprint = Blueprint('food_library', __name__, url_prefix='/api/food-library')

    def payload():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise FoodLibraryError('请提交有效的 JSON 对象')
        return data

    @blueprint.errorhandler(FoodLibraryError)
    def invalid_input(error):
        return jsonify({'success': False, 'error': str(error)}), error.status

    @blueprint.errorhandler(sqlite3.Error)
    @blueprint.errorhandler(OSError)
    def unavailable(error):
        current_app.logger.error('Food library unavailable: %s', error)
        return jsonify({'success': False, 'error': '辅食库暂时无法读写，请稍后重试'}), 503

    @blueprint.get('')
    def get_library():
        return jsonify(store.snapshot())

    @blueprint.post('/categories')
    def create_category():
        identifier = store.save_category(payload())
        return jsonify({'success': True, 'id': identifier}), 201

    @blueprint.route('/categories/<int:identifier>', methods=['PUT', 'DELETE'])
    def change_category(identifier):
        if request.method == 'DELETE':
            store.delete_category(identifier)
        else:
            store.save_category(payload(), identifier)
        return jsonify({'success': True})

    @blueprint.post('/foods')
    def create_food():
        identifier = store.save_food(payload())
        return jsonify({'success': True, 'id': identifier}), 201

    @blueprint.route('/foods/<int:identifier>', methods=['PUT', 'DELETE'])
    def change_food(identifier):
        if request.method == 'DELETE':
            store.delete_food(identifier)
        else:
            store.save_food(payload(), identifier)
        return jsonify({'success': True})

    app.register_blueprint(blueprint)
