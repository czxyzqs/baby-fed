"""辅食库图片导入：RapidOCR 识别图中文字，MiniMax 提取品类与食物建议。"""
import io
import json
import os
import re
import urllib.request

from flask import Blueprint, jsonify, request

from food_library import FoodLibraryStore

MINIMAX_API_KEY = os.getenv('MINIMAX_API_KEY', '')
MINIMAX_BASE_URL = os.getenv('MINIMAX_BASE_URL', 'https://api.minimaxi.com/v1/chat/completions')
MINIMAX_MODEL = os.getenv('MINIMAX_OCR_MODEL', 'MiniMax-M3')

MAX_IMAGE_BYTES = 8 * 1024 * 1024
ALLOWED_TYPES = {'image/jpeg', 'image/png', 'image/webp'}

_engine = None


class OcrImportError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def ocr_engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
    return _engine


def run_ocr(image_bytes):
    import numpy as np
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert('RGB')
    result, _ = ocr_engine()(np.array(image))
    lines = []
    for item in result or []:
        text = str(item[1] or '').strip()
        if text:
            lines.append(text)
    return lines


EXTRACT_PROMPT = '''你是宝宝辅食库的整理助手。下面是一张图片 OCR 识别出的文字（可能来自辅食清单、育儿笔记、食谱、辅食包装说明），以及辅食库中现有的品类和食物。

OCR 文字（按行）：
{lines}

现有品类：{categories}
现有食物：{foods}

请从中提取适合加入宝宝辅食库的食物名称，按品类分组。只输出一个 JSON 对象，不要输出任何其他文字，格式：
{{"groups": [{{"category_name": "品类名", "emoji": "🥬", "is_high_allergen": false, "is_new_category": false, "foods": ["食物名"]}}]}}

规则：
1. 优先归入现有品类：此时 is_new_category 为 false，且 category_name 必须与某个现有品类名完全一致（不要给 emoji）
2. 只有现有品类都明显不合适时才建议新品类：is_new_category 为 true，起简短品类名（不超过 4 个字）并选一个贴切的 emoji
3. 只提取真实食物名：去掉数量、日期、做法、品牌、说明性文字；同一种食物去重
4. 蛋类、鱼虾贝类、坚果、大豆、小麦、乳制品等高致敏品类整组标 is_high_allergen 为 true
5. 图片里没有可加入辅食库的食物时输出 {{"groups": []}}'''


def call_minimax(prompt):
    payload = json.dumps({
        'model': MINIMAX_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'max_tokens': 2000,
        'temperature': 0.2,
    }).encode('utf-8')
    req = urllib.request.Request(
        MINIMAX_BASE_URL,
        data=payload,
        headers={
            'Authorization': f'Bearer {MINIMAX_API_KEY}',
            'Content-Type': 'application/json; charset=utf-8',
        },
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    choices = data.get('choices') or []
    return str((choices[0].get('message') or {}).get('content') or '') if choices else ''


def extract_groups(lines, snapshot):
    if not MINIMAX_API_KEY:
        raise OcrImportError('未配置 MINIMAX_API_KEY，无法智能提取', 503)
    category_names = '、'.join(
        f"{row['name']}({row['emoji']})" for row in snapshot['categories']
    ) or '（暂无品类）'
    food_names = '、'.join(row['name'] for row in snapshot['foods']) or '（暂无食物）'
    prompt = EXTRACT_PROMPT.format(
        lines='\n'.join(lines), categories=category_names, foods=food_names
    )
    content = call_minimax(prompt)
    # MiniMax-M 系列回复可能带 <think> 推理段，先剥离再取最外层 JSON
    content = re.sub(r'<think>.*?</think>', '', content, flags=re.S)
    match = re.search(r'\{.*\}', content, flags=re.S)
    if match is None:
        raise OcrImportError('AI 返回结果无法解析，请重试或换一张更清晰的图片', 502)
    try:
        groups = json.loads(match.group(0)).get('groups') or []
    except ValueError:
        raise OcrImportError('AI 返回结果无法解析，请重试或换一张更清晰的图片', 502)
    return [group for group in groups if isinstance(group, dict)]


def attach_existing(group, snapshot):
    """以后端数据为准匹配现有品类与已有食物，弱化 AI 幻觉。"""
    name = str(group.get('category_name') or '').strip()
    existing = next(
        (row for row in snapshot['categories'] if row['name'] == name), None
    )
    existing_id = None
    is_new = True
    if existing is not None:
        existing_id = existing['id']
        is_new = False
    elif any(row['name'] in name or name in row['name'] for row in snapshot['categories']):
        same = next(row for row in snapshot['categories'] if row['name'] in name or name in row['name'])
        existing_id = same['id']
        is_new = False
    known_names = {row['name'] for row in snapshot['foods']}
    foods = []
    for item in group.get('foods') or []:
        food_name = str(item or '').strip()[:50]
        if not food_name:
            continue
        foods.append({'name': food_name, 'exists': food_name in known_names})
    return {
        'category_name': name or '未命名品类',
        'emoji': str(group.get('emoji') or '🥣')[:16],
        'is_high_allergen': group.get('is_high_allergen') is True,
        'existing_category_id': existing_id,
        'is_new_category': is_new,
        'foods': foods,
    }


def register_food_ocr(app, data_dir):
    store = FoodLibraryStore(data_dir)
    blueprint = Blueprint('food_ocr', __name__, url_prefix='/api/food-library')

    @blueprint.errorhandler(OcrImportError)
    def ocr_failed(error):
        return jsonify({'success': False, 'error': error.message}), error.status

    @blueprint.post('/ocr/import')
    def import_from_image():
        image = request.files.get('image')
        if image is None:
            raise OcrImportError('请选择要识别的图片')
        if image.mimetype not in ALLOWED_TYPES:
            raise OcrImportError('仅支持 JPG、PNG、WebP 格式图片')
        image_bytes = image.read()
        if len(image_bytes) > MAX_IMAGE_BYTES:
            raise OcrImportError('图片不能超过 8MB，请压缩后重试')
        try:
            lines = run_ocr(image_bytes)
        except Exception:
            raise OcrImportError('图片读取失败，请确认图片未损坏后重试')
        if not lines:
            return jsonify({'success': True, 'lines': [], 'groups': []})
        snapshot = store.snapshot()
        groups = [attach_existing(group, snapshot) for group in extract_groups(lines, snapshot)]
        return jsonify({'success': True, 'lines': lines, 'groups': groups})

    app.register_blueprint(blueprint)
