# 补剂设置弹窗实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增独立的补剂添加弹窗，支持每天、自定义间隔、自定义周几、交替组四种频率类型

**Architecture:** 前端修改 templates/index.html，新增添加弹窗和图标选择器；后端修改 baby.py 中 get_today_supplements() 支持新频率类型

**Tech Stack:** Flask (后端), HTML/JS (前端)

---

## 文件结构

- Modify: `templates/index.html:3479-3532` - 替换 addSupplement() 函数，新增添加弹窗
- Modify: `baby.py:186-221` - 更新 get_today_supplements() 支持 custom 类型

---

## 任务 1: 新增补剂添加弹窗 HTML

**Files:**
- Modify: `templates/index.html:3518-3532`

- [ ] **Step 1: 在补剂设置弹窗后添加新的添加弹窗 HTML**

在 `</div>` (supplement-settings-modal 结束后) 添加:

```html
<!-- 添加补剂弹窗 -->
<div id="supplement-add-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1100;justify-content:center;align-items:center;">
  <div style="background:white;border-radius:16px;width:90%;max-width:400px;max-height:80vh;overflow-y:auto;padding:24px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h3 style="margin:0;">添加补剂</h3>
      <button onclick="closeSupplementAdd()" style="background:none;border:none;font-size:24px;cursor:pointer;">&times;</button>
    </div>
    
    <!-- 名称 -->
    <div style="margin-bottom:16px;">
      <label style="display:block;font-size:14px;color:#666;margin-bottom:6px;">名称</label>
      <input type="text" id="supp-add-name" placeholder="如：D3、AD、DHA" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:15px;box-sizing:border-box;">
    </div>
    
    <!-- 图标选择 -->
    <div style="margin-bottom:16px;">
      <label style="display:block;font-size:14px;color:#666;margin-bottom:6px;">图标</label>
      <div style="display:flex;align-items:center;gap:10px;">
        <div id="supp-add-icon-display" onclick="toggleIconPicker()" style="width:48px;height:48px;background:#f5f5f5;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;border:2px solid #ddd;">💊</div>
        <span style="color:#999;font-size:13px;">点击选择图标</span>
      </div>
      <div id="supp-add-icon-picker" style="display:none;margin-top:8px;padding:12px;background:#f9f9f9;border-radius:8px;grid-template-columns:repeat(5,1fr);gap:8px;">
        <span onclick="selectSuppIcon('💊')" style="cursor:pointer;font-size:24px;padding:4px;">💊</span>
        <span onclick="selectSuppIcon('☀️')" style="cursor:pointer;font-size:24px;padding:4px;">☀️</span>
        <span onclick="selectSuppIcon('🌟')" style="cursor:pointer;font-size:24px;padding:4px;">🌟</span>
        <span onclick="selectSuppIcon('🫙')" style="cursor:pointer;font-size:24px;padding:4px;">🫙</span>
        <span onclick="selectSuppIcon('🔩')" style="cursor:pointer;font-size:24px;padding:4px;">🔩</span>
        <span onclick="selectSuppIcon('🐟')" style="cursor:pointer;font-size:24px;padding:4px;">🐟</span>
        <span onclick="selectSuppIcon('💪')" style="cursor:pointer;font-size:24px;padding:4px;">💪</span>
        <span onclick="selectSuppIcon('🧠')" style="cursor:pointer;font-size:24px;padding:4px;">🧠</span>
        <span onclick="selectSuppIcon('🍎')" style="cursor:pointer;font-size:24px;padding:4px;">🍎</span>
        <span onclick="selectSuppIcon('💜')" style="cursor:pointer;font-size:24px;padding:4px;">💜</span>
      </div>
    </div>
    
    <!-- 频率类型 -->
    <div style="margin-bottom:16px;">
      <label style="display:block;font-size:14px;color:#666;margin-bottom:6px;">频率</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" class="freq-btn selected" data-value="daily" onclick="selectFreqType('daily')" style="padding:8px 16px;border:1px solid #ddd;border-radius:20px;background:white;cursor:pointer;font-size:14px;">每天</button>
        <button type="button" class="freq-btn" data-value="interval" onclick="selectFreqType('interval')" style="padding:8px 16px;border:1px solid #ddd;border-radius:20px;background:white;cursor:pointer;font-size:14px;">按天</button>
        <button type="button" class="freq-btn" data-value="weekdays" onclick="selectFreqType('weekdays')" style="padding:8px 16px;border:1px solid #ddd;border-radius:20px;background:white;cursor:pointer;font-size:14px;">按周</button>
        <button type="button" class="freq-btn" data-value="alternating" onclick="selectFreqType('alternating')" style="padding:8px 16px;border:1px solid #ddd;border-radius:20px;background:white;cursor:pointer;font-size:14px;">交替组</button>
      </div>
    </div>
    
    <!-- 按天设置 -->
    <div id="supp-add-interval-section" style="display:none;margin-bottom:16px;padding:12px;background:#f5f5f5;border-radius:8px;">
      <label style="font-size:14px;">每</label>
      <input type="number" id="supp-add-interval-days" value="2" min="2" style="width:60px;padding:8px;border:1px solid #ddd;border-radius:6px;text-align:center;font-size:15px;margin:0 8px;">
      <label style="font-size:14px;">天吃一次</label>
    </div>
    
    <!-- 按周设置 -->
    <div id="supp-add-weekdays-section" style="display:none;margin-bottom:16px;padding:12px;background:#f5f5f5;border-radius:8px;">
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" value="1" class="weekday-cb"> 周一</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" value="2" class="weekday-cb"> 周二</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" value="3" class="weekday-cb"> 周三</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" value="4" class="weekday-cb"> 周四</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" value="5" class="weekday-cb"> 周五</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" value="6" class="weekday-cb"> 周六</label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" value="0" class="weekday-cb"> 周日</label>
      </div>
    </div>
    
    <!-- 交替组设置 -->
    <div id="supp-add-alternating-section" style="display:none;margin-bottom:16px;padding:12px;background:#f5f5f5;border-radius:8px;">
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:14px;margin-bottom:6px;">加入交替组</label>
        <select id="supp-add-group-select" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px;">
          <option value="">-- 选择交替组 --</option>
        </select>
        <button onclick="createNewGroup()" style="margin-top:8px;padding:6px 12px;background:#4A90D9;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;">+ 创建新交替组</button>
      </div>
      <div>
        <label style="display:block;font-size:14px;margin-bottom:6px;">起始日期</label>
        <input type="date" id="supp-add-start-date" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px;">
      </div>
    </div>
    
    <!-- 操作按钮 -->
    <div style="margin-top:20px;display:flex;gap:12px;">
      <button onclick="closeSupplementAdd()" style="flex:1;padding:12px;background:#f5f5f5;color:#333;border:none;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer;">取消</button>
      <button onclick="confirmAddSupplement()" style="flex:1;padding:12px;background:#4A90D9;color:white;border:none;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer;">确认添加</button>
    </div>
  </div>
</div>

<!-- 图标选择器样式补充 -->
<style>
.freq-btn.selected { background:#4A90D9;color:white;border-color:#4A90D9; }
</style>
```

- [ ] **Step 2: 替换 addSupplement() 函数调用**

将原 `addSupplement()` 按钮的 onclick 改为 `openSupplementAddModal()`:

```html
<!-- 找到原来的 -->
<button onclick="addSupplement()" ...>+ 添加补剂</button>

<!-- 替换为 -->
<button onclick="openSupplementAddModal()" ...>+ 添加补剂</button>
```

---

## 任务 2: 新增 JS 函数

**Files:**
- Modify: `templates/index.html:3433-3516` - 在现有脚本中添加新函数

- [ ] **Step 1: 在 openSupplementSettings() 函数后添加新函数**

```javascript
let selectedIcon = '💊';
let selectedFreqType = 'daily';

function openSupplementAddModal() {
  // 重置表单
  document.getElementById('supp-add-name').value = '';
  selectedIcon = '💊';
  document.getElementById('supp-add-icon-display').textContent = '💊';
  selectedFreqType = 'daily';
  updateFreqButtonsUI();
  hideAllFreqSections();
  
  // 加载交替组到下拉框
  loadAlternatingGroups();
  
  // 设置默认起始日期为今天
  document.getElementById('supp-add-start-date').value = new Date().toISOString().split('T')[0];
  
  // 显示弹窗
  document.getElementById('supplement-add-modal').style.display = 'flex';
}

function closeSupplementAdd() {
  document.getElementById('supplement-add-modal').style.display = 'none';
}

function toggleIconPicker() {
  const picker = document.getElementById('supp-add-icon-picker');
  picker.style.display = picker.style.display === 'none' ? 'grid' : 'none';
}

function selectSuppIcon(icon) {
  selectedIcon = icon;
  document.getElementById('supp-add-icon-display').textContent = icon;
  document.getElementById('supp-add-icon-picker').style.display = 'none';
}

function selectFreqType(type) {
  selectedFreqType = type;
  updateFreqButtonsUI();
  hideAllFreqSections();
  
  if (type === 'interval') {
    document.getElementById('supp-add-interval-section').style.display = 'block';
  } else if (type === 'weekdays') {
    document.getElementById('supp-add-weekdays-section').style.display = 'block';
  } else if (type === 'alternating') {
    document.getElementById('supp-add-alternating-section').style.display = 'block';
  }
}

function updateFreqButtonsUI() {
  document.querySelectorAll('.freq-btn').forEach(btn => {
    if (btn.dataset.value === selectedFreqType) {
      btn.classList.add('selected');
    } else {
      btn.classList.remove('selected');
    }
  });
}

function hideAllFreqSections() {
  document.getElementById('supp-add-interval-section').style.display = 'none';
  document.getElementById('supp-add-weekdays-section').style.display = 'none';
  document.getElementById('supp-add-alternating-section').style.display = 'none';
}

function loadAlternatingGroups() {
  const select = document.getElementById('supp-add-group-select');
  select.innerHTML = '<option value="">-- 选择交替组 --</option>';
  
  supplementSettings.alternatingGroups.forEach(group => {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = group.name + ' (' + group.members.length + '种)';
    select.appendChild(option);
  });
}

function createNewGroup() {
  const name = prompt('新交替组名称:');
  if (!name) return;
  
  const groupId = 'group_' + Date.now();
  supplementSettings.alternatingGroups.push({
    id: groupId,
    name: name,
    members: [],
    startDate: new Date().toISOString().split('T')[0],
    startIndex: 0
  });
  
  loadAlternatingGroups();
  document.getElementById('supp-add-group-select').value = groupId;
}

function confirmAddSupplement() {
  const name = document.getElementById('supp-add-name').value.trim();
  if (!name) {
    alert('请输入补剂名称');
    return;
  }
  
  const id = name.toLowerCase().replace(/\s/g, '_').replace(/[^a-z0-9_]/g, '');
  
  const newSupp = {
    id: id,
    name: name,
    icon: selectedIcon,
    frequencyType: selectedFreqType,
    customType: null,
    intervalDays: null,
    customDays: null,
    groupId: null,
    startDate: null,
    startIndex: null
  };
  
  if (selectedFreqType === 'interval') {
    newSupp.frequencyType = 'custom';
    newSupp.customType = 'interval';
    newSupp.intervalDays = parseInt(document.getElementById('supp-add-interval-days').value) || 2;
  } else if (selectedFreqType === 'weekdays') {
    newSupp.frequencyType = 'custom';
    newSupp.customType = 'weekdays';
    newSupp.customDays = Array.from(document.querySelectorAll('.weekday-cb:checked')).map(cb => parseInt(cb.value));
    if (newSupp.customDays.length === 0) {
      alert('请选择至少一天');
      return;
    }
  } else if (selectedFreqType === 'alternating') {
    const groupId = document.getElementById('supp-add-group-select').value;
    if (!groupId) {
      alert('请选择交替组');
      return;
    }
    newSupp.groupId = groupId;
    newSupp.startDate = document.getElementById('supp-add-start-date').value;
    
    // 加入组的成员列表
    const group = supplementSettings.alternatingGroups.find(g => g.id === groupId);
    if (group) {
      group.members.push(id);
    }
  }
  
  supplementSettings.supplements.push(newSupp);
  renderSupplementList();
  closeSupplementAdd();
}
```

---

## 任务 3: 更新后端 get_today_supplements()

**Files:**
- Modify: `baby.py:186-221` - 更新函数支持 custom 类型

- [ ] **Step 1: 更新 get_today_supplements() 函数**

找到原函数，替换为:

```python
def get_today_supplements(settings, date):
    """Calculate which supplements to take today based on settings."""
    result = {}
    date_obj = datetime.strptime(date, '%Y-%m-%d')
    weekday = date_obj.weekday()  # 0=Monday, 6=Sunday

    for supp in settings.get('supplements', []):
        freq_type = supp.get('frequencyType', 'daily')

        if freq_type == 'daily':
            result[supp['id']] = True
        elif freq_type == 'custom':
            custom_type = supp.get('customType', 'interval')
            if custom_type == 'interval':
                interval = supp.get('intervalDays', 2)
                start_str = supp.get('startDate', date)
                start = datetime.strptime(start_str, '%Y-%m-%d')
                days_diff = (date_obj - start).days
                result[supp['id']] = days_diff % interval == 0
            elif custom_type == 'weekdays':
                custom_days = supp.get('customDays', [])
                result[supp['id']] = weekday in custom_days
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
```

- [ ] **Step 2: 提交更改**

```bash
git add templates/index.html baby.py
git commit -m "feat: add supplement add modal with custom frequency support"
```
