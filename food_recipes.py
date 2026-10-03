"""辅食食谱：拍照收藏 + OCR/AI 结构化，按关键词或食材搜索，与辅食库共库联动过敏标注。"""
import json
import os
import re
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Blueprint, jsonify, request, send_from_directory

from food_ocr import call_zhipu, run_ocr

CN_TZ = ZoneInfo('Asia/Shanghai')
MAX_IMAGE_BYTES = 8 * 1024 * 1024
ALLOWED_TYPES = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'}

RECIPE_PROMPT = '''你是宝宝辅食食谱整理助手。下面是一张图片 OCR 识别出的文字，来自辅食食谱（可能是小红书笔记、食谱书页等）。

OCR 文字（按行）：
{lines}

请整理成一份辅食食谱，只输出一个 JSON 对象，不要输出任何其他文字，格式：
{{"title": "菜名", "months_min": 6, "ingredients": ["食材1", "食材2"], "steps": "做法步骤，一步一行"}}

规则：
1. title 取图片中的菜名；没有明确菜名就用主要食材概括（如「西兰花米糊」）
2. months_min 是适领最小月龄：文中明确写了就用文中的；没写就按形态估——泥糊类 6、碎末软烂 8、小颗粒 10、块状/调味 12
3. ingredients 只列真实的食物食材名，去掉调料中的盐糖（1 岁内无盐糖）、水量等；同一种食材去重
4. steps 保留原文做法，整理成一步一步的短句，每步一行（用换行分隔），没有做法就给空字符串'''


class RecipeError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def now_cn():
    return datetime.now(CN_TZ).isoformat()


IMAGE_NAME_PATTERN = re.compile(r'[0-9a-f]{32}\.(jpg|png|webp)')


def parse_images(value):
    """image 字段存 JSON 数组；兼容早期单文件名格式。"""
    if not value:
        return []
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return [name for name in parsed if IMAGE_NAME_PATTERN.fullmatch(str(name))]
    except (TypeError, ValueError):
        pass
    name = str(value)
    return [name] if IMAGE_NAME_PATTERN.fullmatch(name) else []


def clean_image_names(value):
    """接收任意输入，返回合法的去重图片名列表。"""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    seen = []
    for name in value:
        text = str(name)
        if IMAGE_NAME_PATTERN.fullmatch(text) and text not in seen:
            seen.append(text)
    return seen


class RecipeStore:
    def __init__(self, data_dir):
        self.path = Path(data_dir) / 'baby-food.db'
        self.image_dir = Path(data_dir) / 'recipes'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute('''CREATE TABLE IF NOT EXISTS recipes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                months_min INTEGER NOT NULL DEFAULT 6,
                ingredients TEXT NOT NULL DEFAULT '[]',
                steps TEXT NOT NULL DEFAULT '',
                image TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )''')

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys = ON')
        return connection

    def allergen_map(self, connection):
        """食物名 -> 过敏/排敏状态（取每个食物最新一轮）。"""
        result = {}
        for row in connection.execute('''
            SELECT f.name AS name, r.status AS status FROM food_rounds r
            JOIN foods f ON f.id = r.food_id
            WHERE r.id IN (SELECT MAX(id) FROM food_rounds GROUP BY food_id)
        '''):
            result[row['name']] = row['status']
        return result

    def rows_to_recipes(self, rows, connection):
        allergens = self.allergen_map(connection)
        recipes = []
        for row in rows:
            item = dict(row)
            try:
                item['ingredients'] = json.loads(item['ingredients'])
            except (TypeError, ValueError):
                item['ingredients'] = []
            item['images'] = parse_images(item.pop('image', ''))
            item['warnings'] = sorted({
                name for name in item['ingredients']
                if allergens.get(name) == 'allergic'
            })
            recipes.append(item)
        return recipes

    def list(self, query=''):
        with self.connect() as connection:
            rows = connection.execute(
                'SELECT * FROM recipes ORDER BY id DESC'
            ).fetchall()
            recipes = self.rows_to_recipes(rows, connection)
        query = (query or '').strip().lower()
        if not query:
            return {'recipes': recipes}
        matched = []
        for item in recipes:
            haystack = ' '.join([
                item['title'], item['steps'], item['note'],
                *item['ingredients'],
            ]).lower()
            if query in haystack or fuzzy_contains(haystack, query):
                matched.append(item)
        return {'recipes': matched}

    def require(self, connection, identifier):
        row = connection.execute('SELECT id FROM recipes WHERE id = ?', (identifier,)).fetchone()
        if row is None:
            raise RecipeError('食谱已不存在，请刷新后重试', 404)

    def get(self, identifier):
        with self.connect() as connection:
            self.require(connection, identifier)
            row = connection.execute('SELECT * FROM recipes WHERE id = ?', (identifier,)).fetchone()
            return {'recipe': self.rows_to_recipes([row], connection)[0]}

    def validate(self, data):
        title = str(data.get('title') or '').strip()[:60]
        if not title:
            raise RecipeError('菜名不能为空')
        months = data.get('months_min', 6)
        if type(months) is not int or not 4 <= months <= 36:
            raise RecipeError('适领月龄只能是 4 到 36 个月')
        ingredients = data.get('ingredients')
        if not isinstance(ingredients, list) or not ingredients:
            raise RecipeError('至少要有一个食材')
        ingredients = [str(name).strip()[:30] for name in ingredients if str(name).strip()]
        if not ingredients:
            raise RecipeError('至少要有一个食材')
        return {
            'title': title,
            'months_min': months,
            'ingredients': json.dumps(ingredients, ensure_ascii=False),
            'steps': str(data.get('steps') or '').strip()[:4000],
            'note': str(data.get('note') or '').strip()[:200],
        }

    def create(self, data, image_names=None):
        values = self.validate(data)
        image_names = clean_image_names(image_names)
        stamp = now_cn()
        with self.connect() as connection:
            cursor = connection.execute(
                'INSERT INTO recipes (title, months_min, ingredients, steps, image, note, created_at, updated_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (values['title'], values['months_min'], values['ingredients'],
                 values['steps'], json.dumps(image_names), values['note'], stamp, stamp),
            )
            return cursor.lastrowid

    def update(self, identifier, data, image_names=None):
        values = self.validate(data)
        with self.connect() as connection:
            self.require(connection, identifier)
            assignments = [
                'title = ?', 'months_min = ?', 'ingredients = ?', 'steps = ?', 'note = ?', 'updated_at = ?'
            ]
            params = [values['title'], values['months_min'], values['ingredients'],
                      values['steps'], values['note'], now_cn()]
            if image_names is not None:
                assignments.insert(4, 'image = ?')
                params.insert(4, json.dumps(clean_image_names(image_names)))
            params.append(identifier)
            connection.execute(
                f"UPDATE recipes SET {', '.join(assignments)} WHERE id = ?", params,
            )
            return identifier

    def delete(self, identifier):
        with self.connect() as connection:
            self.require(connection, identifier)
            row = connection.execute('SELECT image FROM recipes WHERE id = ?', (identifier,)).fetchone()
            connection.execute('DELETE FROM recipes WHERE id = ?', (identifier,))
            return parse_images(row['image']) if row else []

    def save_image(self, image_bytes, extension):
        self.image_dir.mkdir(parents=True, exist_ok=True)
        name = f'{uuid.uuid4().hex}.{extension}'
        (self.image_dir / name).write_bytes(image_bytes)
        return name


def fuzzy_contains(haystack, query):
    """搜索字符按顺序出现即命中（与辅食库一致），支持空格分隔多词。"""
    for word in query.split():
        index = 0
        for character in word:
            index = haystack.find(character, index)
            if index == -1:
                return False
            index += 1
    return True


def extract_recipe(lines):
    prompt = RECIPE_PROMPT.format(lines='\n'.join(lines))
    content, finish_reason = call_zhipu(prompt)
    if finish_reason == 'length':
        content, finish_reason = call_zhipu(prompt)
    match = re.search(r'\{.*\}', content, flags=re.S)
    if match is None:
        raise RecipeError('AI 返回结果无法解析，请换一张更清晰的食谱图片', 502)
    try:
        data = json.loads(match.group(0))
    except ValueError:
        raise RecipeError('AI 返回结果无法解析，请换一张更清晰的食谱图片', 502)
    months = data.get('months_min')
    if type(months) is not int or not 4 <= months <= 36:
        months = 6
    ingredients = [
        str(name).strip()[:30] for name in (data.get('ingredients') or [])
        if str(name).strip()
    ]
    return {
        'title': str(data.get('title') or '').strip()[:60] or '未命名食谱',
        'months_min': months,
        'ingredients': ingredients,
        'steps': str(data.get('steps') or '').strip()[:4000],
    }


def register_food_recipes(app, data_dir):
    store = RecipeStore(data_dir)
    blueprint = Blueprint('food_recipes', __name__, url_prefix='/api/food-recipes')

    @blueprint.errorhandler(RecipeError)
    def recipe_failed(error):
        return jsonify({'success': False, 'error': error.message}), error.status

    @blueprint.errorhandler(sqlite3.Error)
    @blueprint.errorhandler(OSError)
    def unavailable(error):
        return jsonify({'success': False, 'error': '数据服务暂时不可用，请稍后重试'}), 503

    @blueprint.get('')
    def list_recipes():
        return jsonify(store.list(request.args.get('q', '')))

    @blueprint.get('/<int:identifier>')
    def get_recipe(identifier):
        return jsonify(store.get(identifier))

    @blueprint.post('')
    def create_recipe():
        data = request.get_json(silent=True) or {}
        return jsonify({'success': True, 'id': store.create(data, data.get('image_names'))}), 201

    @blueprint.put('/<int:identifier>')
    def update_recipe(identifier):
        data = request.get_json(silent=True) or {}
        store.update(identifier, data, data.get('image_names'))
        return jsonify({'success': True, 'id': identifier})

    @blueprint.delete('/<int:identifier>')
    def delete_recipe(identifier):
        for image in store.delete(identifier):
            try:
                (store.image_dir / image).unlink(missing_ok=True)
            except OSError:
                pass
        return jsonify({'success': True})

    @blueprint.post('/ocr')
    def ocr_recipe():
        images = [file for file in request.files.getlist('image') if file and file.filename]
        if not images:
            raise RecipeError('请选择要识别的图片')
        saved = []
        all_lines = []
        for image in images[:9]:
            if image.mimetype not in ALLOWED_TYPES:
                raise RecipeError('仅支持 JPG、PNG、WebP 格式图片')
            image_bytes = image.read()
            if len(image_bytes) > MAX_IMAGE_BYTES:
                raise RecipeError('单张图片不能超过 8MB，请压缩后重试')
            try:
                all_lines.extend(run_ocr(image_bytes))
            except Exception:
                raise RecipeError('图片读取失败，请确认图片未损坏后重试')
            saved.append(store.save_image(image_bytes, ALLOWED_TYPES[image.mimetype]))
        if not all_lines:
            for name in saved:
                (store.image_dir / name).unlink(missing_ok=True)
            raise RecipeError('没有从图片中识别出文字，请换一张文字更清晰的食谱图')
        try:
            draft = extract_recipe(all_lines)
        except Exception:
            for name in saved:
                (store.image_dir / name).unlink(missing_ok=True)
            raise
        draft['image_names'] = saved
        return jsonify({'success': True, 'lines': all_lines, 'draft': draft})

    @blueprint.post('/images')
    def upload_images():
        images = [file for file in request.files.getlist('image') if file and file.filename]
        if not images:
            raise RecipeError('请选择要上传的图片')
        saved = []
        for image in images[:9]:
            if image.mimetype not in ALLOWED_TYPES:
                raise RecipeError('仅支持 JPG、PNG、WebP 格式图片')
            image_bytes = image.read()
            if len(image_bytes) > MAX_IMAGE_BYTES:
                raise RecipeError('单张图片不能超过 8MB，请压缩后重试')
            saved.append(store.save_image(image_bytes, ALLOWED_TYPES[image.mimetype]))
        return jsonify({'success': True, 'image_names': saved})

    @blueprint.get('/images/<path:name>')
    def recipe_image(name):
        if not re.fullmatch(r'[0-9a-f]{32}\.(jpg|png|webp)', name):
            raise RecipeError('无效的图片路径', 404)
        return send_from_directory(store.image_dir, name)

    app.register_blueprint(blueprint)
