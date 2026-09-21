let page = window.INIT_RECORDS_PAGE.page;
let hasMore = window.INIT_RECORDS_PAGE.hasMore;
let isLoading = false;
const dateFilter = window.INIT_RECORDS_PAGE.dateFilter;
const typeFilter = window.INIT_RECORDS_PAGE.typeFilter;
const recordsById = new Map((window.INIT_RECORDS_PAGE.records || []).map(record => [record.id, record]));

// Date picker state
let recordsCalSelectedDate = dateFilter;
const now = new Date();
let recordsCalYear = now.getFullYear();
let recordsCalMonth = now.getMonth();

function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function formatDateDisplay(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    const now = new Date();
    const todayStr = formatDate(now);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];

    if (dateStr === todayStr) {
        return `${month}月${day}日 (${weekDay}) - 今天`;
    } else if (dateStr === yesterdayStr) {
        return `${month}月${day}日 (${weekDay}) - 昨天`;
    } else {
        return `${year}年${month}月${day}日 (${weekDay})`;
    }
}

// Initialize display on load
document.getElementById('records-current-date-text').textContent = formatDateDisplay(recordsCalSelectedDate);

function toggleRecordsDatePicker() {
    const calendar = document.getElementById('records-date-calendar');
    const arrow = document.querySelector('#records-date-picker .date-picker-arrow');
    if (calendar.style.display === 'none') {
        calendar.style.display = 'block';
        arrow.style.transform = 'rotate(180deg)';
        initRecordsCalendar(recordsCalYear, recordsCalMonth);
    } else {
        calendar.style.display = 'none';
        arrow.style.transform = 'rotate(0deg)';
    }
}

function initRecordsCalendar(year, month) {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    recordsCalYear = year;
    recordsCalMonth = month;

    document.getElementById('records-cal-title').textContent = `${year}年${month + 1}月`;

    const daysContainer = document.getElementById('records-cal-days');
    daysContainer.innerHTML = '';

    // Previous month days
    const prevMonth = new Date(year, month, 0);
    const prevMonthDays = prevMonth.getDate();
    for (let i = startDay - 1; i >= 0; i--) {
        const day = prevMonthDays - i;
        const date = new Date(year, month - 1, day);
        const dateStr = formatDate(date);
        daysContainer.innerHTML += `<div class="cal-day other-month" onclick="selectRecordsDate('${dateStr}')">${day}</div>`;
    }

    // Current month days
    const now = new Date();
    const todayStr = formatDate(now);
    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dateStr = formatDate(date);
        let classes = 'cal-day';
        if (dateStr === todayStr) classes += ' today';
        if (dateStr === recordsCalSelectedDate) classes += ' selected';
        daysContainer.innerHTML += `<div class="${classes}" onclick="selectRecordsDate('${dateStr}')">${day}</div>`;
    }

    // Next month days
    const totalCells = startDay + daysInMonth;
    const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remainingCells; i++) {
        const date = new Date(year, month + 1, i);
        const dateStr = formatDate(date);
        daysContainer.innerHTML += `<div class="cal-day other-month" onclick="selectRecordsDate('${dateStr}')">${i}</div>`;
    }
}

function recordsCalPrevMonth() {
    if (recordsCalMonth === 0) { recordsCalYear--; recordsCalMonth = 11; }
    else { recordsCalMonth--; }
    initRecordsCalendar(recordsCalYear, recordsCalMonth);
}

function recordsCalNextMonth() {
    if (recordsCalMonth === 11) { recordsCalYear++; recordsCalMonth = 0; }
    else { recordsCalMonth++; }
    initRecordsCalendar(recordsCalYear, recordsCalMonth);
}

function selectRecordsDate(dateStr) {
    recordsCalSelectedDate = dateStr;
    document.getElementById('records-current-date-text').textContent = formatDateDisplay(dateStr);
    toggleRecordsDatePicker();
    navigateWithFilters(dateStr);
}

function goToRecordsToday() {
    const now = new Date();
    recordsCalYear = now.getFullYear();
    recordsCalMonth = now.getMonth();
    recordsCalSelectedDate = formatDate(now);
    document.getElementById('records-current-date-text').textContent = formatDateDisplay(recordsCalSelectedDate);
    initRecordsCalendar(recordsCalYear, recordsCalMonth);
    navigateWithFilters(recordsCalSelectedDate);
}

function navigateWithFilters(date) {
    const type = document.getElementById('typeFilter').value;
    let url = '/records?page=1&date=' + date;
    if (type && type !== 'all') url += '&type=' + type;
    url += '&_t=' + Date.now();
    window.location.href = url;
}

function applyFilters() {
    const type = document.getElementById('typeFilter').value;
    let url = '/records?page=1&date=' + recordsCalSelectedDate;
    if (type && type !== 'all') url += '&type=' + type;
    url += '&_t=' + Date.now();
    window.location.href = url;
}

async function loadMore() {
    if (isLoading || !hasMore) return;
    isLoading = true;
    page++;
    document.getElementById('loadingIndicator').style.display = 'block';

    try {
        let url = `/records/load?page=${page}`;
        if (dateFilter) url += '&date=' + dateFilter;
        if (typeFilter && typeFilter !== 'all') url += '&type=' + typeFilter;

        const res = await fetch(url);
        const data = await res.json();

        if (data.records && data.records.length > 0) {
            const html = data.records.map(renderRecordItem).join('');
            document.getElementById('recordsList').insertAdjacentHTML('beforeend', html);
            hasMore = data.has_more;
            if (!hasMore) {
                document.getElementById('loadingIndicator').style.display = 'none';
                document.getElementById('scrollTrigger').style.display = 'none';
            }
        } else {
            hasMore = false;
            document.getElementById('loadingIndicator').style.display = 'none';
        }
    } catch (e) {
        console.error('Failed to load more:', e);
    }
    isLoading = false;
}

const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
        loadMore();
    }
}, { threshold: 0.1 });

const trigger = document.getElementById('scrollTrigger');
if (trigger) observer.observe(trigger);

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function getRecordPresentation(record) {
    if (record.type === 'feed') {
        return {
            icon: '🍼',
            detail: (record.isNewMilk ? '🆕' : '') + (record.amount || '') + 'ml'
        };
    }
    if (record.type === 'diaper') {
        return {
            icon: '🚽',
            detail: {wet: '💧 尿', dirty: '💩 粑粑', both: '💫 两者'}[record.diaperType] || record.detail || '🚽'
        };
    }
    if (record.type === 'supplement') {
        return {
            icon: '💊',
            detail: record.detail || {D3: '☀️ D3', AD: '🌟 AD', iron: '🔩 铁', probiotic: '🫙 益生菌'}[record.supplementType] || '💊 补剂'
        };
    }
    if (record.type === 'bath') return { icon: '🛁', detail: record.detail || '🛁 洗澡' };
    if (record.type === 'health') {
        return record.healthType === 'temperature'
            ? { icon: '🌡️', detail: `🌡️ 体温 ${record.temperature}°C` }
            : { icon: '💊', detail: `💊 服药 ${record.medicineName || ''}${record.medicineDose ? ` · ${record.medicineDose}` : ''}` };
    }
    if (record.type === 'sleep') {
        return {
            icon: '🛏️',
            detail: record.sleepType === 'sleep' ? '😴 宝宝睡了' : '😃 宝宝醒了'
        };
    }
    if (record.type === 'tummy') {
        return { icon: '🧸', detail: `🧸 练趴 ${record.duration || 1}分钟` };
    }
    return { icon: '📋', detail: record.detail || record.label || '记录' };
}

function renderRecordItem(record) {
    recordsById.set(record.id, record);
    const presentation = getRecordPresentation(record);
    const time = record.time ? record.time.substring(11, 16) : '';
    const date = record.time ? record.time.substring(0, 10) : '';
    return `<div class="record-item" data-record-id="${escapeAttr(record.id)}" onclick="openEditModal('${escapeAttr(record.type)}', '${escapeAttr(record.id)}')">
        <div class="record-icon">${presentation.icon}</div>
        <div class="record-content">
            <div class="record-detail">${escapeHtml(presentation.detail)}</div>
            ${record.note ? `<div style="font-size: 13px; color: var(--text-muted); font-style: italic; margin-top: 4px;">${escapeHtml(record.note)}</div>` : ''}
        </div>
        <div class="record-time">
            <div class="time">${escapeHtml(time)}</div>
            <div class="date">${escapeHtml(date)}</div>
            <div class="record-edit">编辑</div>
        </div>
    </div>`;
}

function showToast(message, icon = '✅') {
    const toast = document.getElementById('toast');
    toast.querySelector('.toast-icon').textContent = icon;
    toast.querySelector('.toast-text').textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

async function formReq(method, url, data) {
    return fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined
    });
}

function getRenderedRecordElement(id) {
    return Array.from(document.querySelectorAll('#recordsList .record-item'))
        .find(element => element.dataset.recordId === id);
}

function recordMatchesCurrentFilters(record) {
    return (!dateFilter || record.time?.startsWith(dateFilter)) &&
        (!typeFilter || typeFilter === 'all' || record.type === typeFilter);
}

function updateRenderedRecord(record) {
    recordsById.set(record.id, record);
    const element = getRenderedRecordElement(record.id);
    if (!element) return;
    if (!recordMatchesCurrentFilters(record)) {
        element.remove();
        return;
    }
    element.outerHTML = renderRecordItem(record);
    const list = document.getElementById('recordsList');
    Array.from(list.querySelectorAll(':scope > .record-item'))
        .sort((a, b) => (recordsById.get(b.dataset.recordId)?.time || '')
            .localeCompare(recordsById.get(a.dataset.recordId)?.time || ''))
        .forEach(item => list.appendChild(item));
}

function removeRenderedRecord(id) {
    recordsById.delete(id);
    getRenderedRecordElement(id)?.remove();
}

function parseLocalTime(isoStr) {
    if (!isoStr || isoStr.includes('+') || isoStr.endsWith('Z')) return new Date(isoStr);
    return new Date(`${isoStr}+08:00`);
}

function toDateTimeLocal(isoStr) {
    const dt = parseLocalTime(isoStr);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}T${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
}

function selectOption(element, group) {
    const siblings = element.parentElement.querySelectorAll('.form-option');
    siblings.forEach(s => s.classList.remove('selected'));
    element.classList.add('selected');
}

function getSelectedValue(groupId) {
    const selected = document.querySelector(`#${groupId}-options .form-option.selected`);
    return selected ? selected.dataset.value : null;
}

function closeModal(type) {
    const overlay = document.getElementById(`${type}-modal`);
    if (!overlay) return;
    overlay.classList.remove('active');
    document.body.style.overflow = '';
}

function setDateTimeAndNote(type, record) {
    document.getElementById(`edit-${type}-id`).value = record.id;
    document.getElementById(`edit-${type}-original-time`).value = record.time || '';
    document.getElementById(`edit-${type}-time`).value = toDateTimeLocal(record.time);
    document.getElementById(`edit-${type}-note`).value = record.note || '';
}

function openEditModal(type, id) {
    const record = recordsById.get(id);
    if (!record) return;

    if (type === 'feed') {
        setDateTimeAndNote('feed', record);
        document.getElementById('edit-feed-amount-input').value = record.amount || 100;
        document.getElementById('edit-feed-is-new-milk').checked = !!record.isNewMilk;
    } else if (type === 'diaper') {
        setDateTimeAndNote('diaper', record);
        document.querySelectorAll('#edit-diaper-type-options .form-option').forEach(o => o.classList.toggle('selected', o.dataset.value === record.diaperType));
    } else if (type === 'sleep') {
        setDateTimeAndNote('sleep', record);
        document.querySelectorAll('#edit-sleep-type-options .form-option').forEach(o => o.classList.toggle('selected', o.dataset.value === record.sleepType));
        toggleSleepPositionFields('edit-sleep', record.sleepType);
        document.querySelectorAll('#edit-sleep-position-options .form-option').forEach(o => o.classList.toggle('selected', o.dataset.value === record.sleepPosition));
    } else if (type === 'supplement') {
        setDateTimeAndNote('supplement', record);
        document.querySelectorAll('#edit-supplement-type-options .form-option').forEach(o => o.classList.toggle('selected', o.dataset.value === record.supplementType || o.dataset.legacyType === record.supplementType));
    } else if (type === 'bath') {
        setDateTimeAndNote('bath', record);
    } else if (type === 'health') {
        setDateTimeAndNote('health', record);
        document.getElementById('edit-health-temperature').value = record.temperature || '';
        document.getElementById('edit-health-medicine-dose').value = record.medicineDose || '';
        document.querySelectorAll('#edit-health-type-options .form-option').forEach(o => o.classList.toggle('selected', o.dataset.value === record.healthType));
        toggleHealthFields(record.healthType);
        loadMedicineOptions(record.medicineName || '');
    } else if (type === 'tummy') {
        setDateTimeAndNote('tummy', record);
        document.getElementById('edit-tummy-duration-input').value = record.duration || 1;
    } else {
        showToast('暂不支持修改', 'ℹ️');
        return;
    }

    document.getElementById(`edit-${type}-modal`).classList.add('active');
    document.body.style.overflow = 'hidden';
}

function resetSleepPositionSelection(prefix) {
    document.querySelectorAll(`#${prefix}-position-options .form-option`).forEach(opt => opt.classList.remove('selected'));
}

function toggleSleepPositionFields(prefix, sleepType) {
    const group = document.getElementById(`${prefix}-position-group`);
    if (!group) return;
    const isSleeping = sleepType === 'sleep';
    group.style.display = isSleeping ? '' : 'none';
    if (!isSleeping) resetSleepPositionSelection(prefix);
}

function adjustEditAmount(delta) {
    const input = document.getElementById('edit-feed-amount-input');
    input.value = Math.max(0, (parseInt(input.value, 10) || 0) + delta);
}

function adjustEditTummyDuration(delta) {
    const input = document.getElementById('edit-tummy-duration-input');
    input.value = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
}

function toggleHealthFields(healthType) {
    document.getElementById('edit-health-temperature-group').style.display = healthType === 'temperature' ? '' : 'none';
    document.getElementById('edit-health-medicine-group').style.display = healthType === 'medicine' ? '' : 'none';
}

async function loadMedicineOptions(selectedMedicine = '') {
    try {
        const response = await fetch('/api/medicine-settings');
        const settings = await response.json();
        const select = document.getElementById('edit-health-medicine-name');
        select.innerHTML = '<option value="">请选择药品</option>';
        (settings.medicines || []).forEach(name => select.add(new Option(name, name, false, name === selectedMedicine)));
        if (selectedMedicine && !(settings.medicines || []).includes(selectedMedicine)) {
            select.add(new Option(`历史药品：${selectedMedicine}`, selectedMedicine, false, true));
        }
    } catch (error) {
        console.error('Failed to load medicine settings:', error);
    }
}

async function submitEditForm(type) {
    const id = document.getElementById(`edit-${type}-id`).value;
    const data = {
        type,
        time: `${document.getElementById(`edit-${type}-time`).value}:00+08:00`,
        note: document.getElementById(`edit-${type}-note`).value
    };

    if (type === 'feed') {
        data.amount = parseInt(document.getElementById('edit-feed-amount-input').value, 10) || null;
        data.isNewMilk = document.getElementById('edit-feed-is-new-milk').checked;
    } else if (type === 'diaper') {
        data.diaperType = getSelectedValue('edit-diaper-type');
    } else if (type === 'sleep') {
        data.sleepType = getSelectedValue('edit-sleep-type');
        if (data.sleepType === 'sleep') {
            data.sleepPosition = getSelectedValue('edit-sleep-position');
            if (!data.sleepPosition) {
                showToast('请选择睡姿', '❌');
                return;
            }
        } else {
            data.sleepPosition = null;
        }
    } else if (type === 'supplement') {
        data.supplementType = getSelectedValue('edit-supplement-type');
    } else if (type === 'tummy') {
        data.duration = Math.max(1, parseInt(document.getElementById('edit-tummy-duration-input').value, 10) || 1);
    } else if (type === 'health') {
        data.healthType = getSelectedValue('edit-health-type');
        if (data.healthType === 'temperature') {
            data.temperature = document.getElementById('edit-health-temperature').value;
            if (!data.temperature) { showToast('请填写体温', '❌'); return; }
        } else {
            data.medicineName = document.getElementById('edit-health-medicine-name').value;
            data.medicineDose = document.getElementById('edit-health-medicine-dose').value.trim();
            if (!data.medicineName) { showToast('请填写药名', '❌'); return; }
        }
    }

    try {
        const response = await formReq('POST', `/api/records/${id}/update`, data);
        if (response.ok) {
            updateRenderedRecord(await response.json());
            closeModal(`edit-${type}`);
            showToast('修改已保存');
        } else {
            showToast('修改失败', '❌');
        }
    } catch (error) {
        console.error('Failed to update record:', error);
        showToast('修改失败', '❌');
    }
}

async function deleteRecord(type) {
    const id = document.getElementById(`edit-${type}-id`).value;
    if (!confirm('确定要删除这条记录吗？')) return;
    try {
        const response = await formReq('POST', `/api/records/${id}/delete`);
        if (response.ok) {
            removeRenderedRecord(id);
            closeModal(`edit-${type}`);
            showToast('记录已删除');
        } else {
            showToast('删除失败', '❌');
        }
    } catch (error) {
        console.error('Failed to delete record:', error);
        showToast('删除失败', '❌');
    }
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay.id.replace('-modal', ''));
    });
});
