"""Persistent food and category management, separate from feeding records."""

from contextlib import contextmanager
from pathlib import Path
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
    def __init__(self, data_dir):
        self.path = Path(data_dir) / 'baby-food.db'

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
            elif version not in (3, 4, 5, 6, 7):
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            if version == 3:
                connection.execute('ALTER TABLE foods ADD COLUMN family TEXT')
                for food, family in FOOD_FAMILY.items():
                    connection.execute(
                        'UPDATE foods SET family = ? WHERE name = ? AND family IS NULL', (family, food))
                connection.execute('PRAGMA user_version = 4')
                version = 4
            elif version not in (3, 4, 5, 6, 7):
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
            elif version not in (4, 5, 6, 7):
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
            elif version not in (5, 6, 7):
                raise FoodLibraryError('辅食库版本不兼容，请检查服务版本', 503)
            if version == 6:
                # 规划份数：计划/当日覆盖带"每餐份数"，用于记录预填与库存预测
                connection.execute('ALTER TABLE food_normal_plans ADD COLUMN portions REAL')
                connection.execute('ALTER TABLE food_menu_overrides ADD COLUMN portions REAL')
                connection.execute('PRAGMA user_version = 7')
                version = 7
            elif version != 7:
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
