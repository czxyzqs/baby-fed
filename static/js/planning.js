(() => {
    const element = name => document.getElementById(`planning-${name}`);
    const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    let schedule = null;
    let monthCursor = null;
    let selectedDay = null;
    let movingBlock = null;
    let paletteMap = {};

    // 按时间线出现顺序给食物轮换分配颜色：相邻排期必不同色，同一食物同色
    function buildColorMap() {
        const palette = ['seg-0', 'seg-1', 'seg-2'];
        const entries = [];
        (schedule.rounds || []).forEach(item => entries.push([item.food_id, item.start_date]));
        schedule.blocks.forEach(block => entries.push([block.food_id, block.start_date]));
        entries.sort((first, second) => first[1].localeCompare(second[1]));
        const order = [];
        entries.forEach(([foodId]) => { if (!order.includes(foodId)) order.push(foodId); });
        const map = {};
        order.forEach((foodId, index) => { map[foodId] = palette[index % palette.length]; });
        return map;
    }

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    function button(text, handler, className = 'planning-btn') {
        const result = node('button', text, className);
        result.type = 'button';
        result.addEventListener('click', handler);
        return result;
    }

    function message(text = '', error = false) {
        element('message').textContent = text;
        element('message').hidden = !text;
        element('message').dataset.error = String(error);
    }

    function toast(text) {
        window.showToast?.(text);
    }

    async function api(path, method = 'GET', data) {
        const response = await fetch(`/api/screening/${path}`, {
            method, cache: 'no-store',
            headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试');
        return result;
    }

    function foodName(id) {
        return schedule.foods[String(id)] || '?';
    }

    function iso(dateValue) {
        // 用本地日期字段拼接，避免 toISOString 转 UTC 造成东八区日期回退一天
        const year = dateValue.getFullYear();
        const month = String(dateValue.getMonth() + 1).padStart(2, '0');
        const day = String(dateValue.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // ---------- 队列 ----------

    function renderQueue() {
        const list = element('queue-list');
        list.replaceChildren();
        if (!schedule.queue.length) {
            list.append(node('p', '队列为空。可从食物池添加未排敏食物，或直接自动生成排期。', 'planning-hint'));
            return;
        }
        schedule.queue.forEach(item => {
            const row = node('div', '', 'planning-queue-item');
            row.dataset.id = item.id;
            const handle = button('☰', () => {}, 'planning-queue-handle');
            handle.setAttribute('aria-label', `长按拖动调整${item.food_name}的顺序`);
            const main = button('', () => {}, 'planning-queue-main');
            main.append(node('strong', item.food_name, 'planning-queue-name'));
            main.append(node('span',
                `${item.category_emoji || '🍚'}${item.category_name || ''}${item.is_high_allergen ? ' ⚠️' : ''} · 观察${item.observe_days}天`,
                'planning-queue-meta'));
            main.addEventListener('click', () => queueItemDialog(item));
            const arrows = node('div', '', 'planning-queue-arrows');
            const up = button('↑', () => queueChange(item.id, { move: 'up' }), 'planning-move');
            up.setAttribute('aria-label', `${item.food_name}提前一位`);
            const down = button('↓', () => queueChange(item.id, { move: 'down' }), 'planning-move');
            down.setAttribute('aria-label', `${item.food_name}靠后一位`);
            arrows.append(up, down);
            row.append(handle, main, arrows);
            enableDrag(row, list, item);
            list.append(row);
        });
    }

    async function actAndReload(action) {
        try {
            await action();
            await reload();
            return true;
        } catch (error) {
            message(`操作失败：${error.message}`, true);
            return false;
        }
    }

    function queueItemDialog(item) {
        const body = node('div', '', 'planning-dialog-body');
        body.append(node('p',
            `${item.category_emoji || '🍚'}${item.category_name || ''}${item.is_high_allergen ? ' ⚠️ 高致敏品类' : ''}`,
            'planning-hint'));
        const state = { days: item.observe_days };
        const daysLabel = node('label', '观察天数（1–14 天）');
        const daysRow = node('div', '', 'planning-queue-days planning-queue-days-dialog');
        const minus = button('－', () => {
            state.days = Math.max(1, state.days - 1);
            value.textContent = `观察${state.days}天`;
        });
        const value = node('span', `观察${state.days}天`, 'planning-queue-days-value');
        const plus = button('＋', () => {
            state.days = Math.min(14, state.days + 1);
            value.textContent = `观察${state.days}天`;
        });
        daysRow.append(minus, value, plus);
        daysLabel.append(daysRow);
        body.append(daysLabel);
        body.append(node('p', '调整顺序：点队列行的 ↑↓，或长按 ☰ 拖动。', 'planning-hint'));
        const footer = node('div', '', 'planning-actions');
        footer.append(button('移出队列', async () => {
            if (!window.confirm(`把「${item.food_name}」移出排敏队列？`)) return;
            if (await actAndReload(() => api(`queue/${item.id}`, 'DELETE'))) closeDialog();
        }, 'planning-btn red'));
        footer.append(button('保存', async () => {
            if (state.days !== item.observe_days) {
                if (!await actAndReload(() => api(`queue/${item.id}`, 'PUT', { observe_days: state.days }))) return;
            }
            closeDialog();
            toast(`已保存「${item.food_name}」`);
        }, 'planning-btn primary'));
        body.append(footer);
        openDialog(item.food_name, body);
    }

    function enableDrag(row, list, item) {
        const handle = row.querySelector('.planning-queue-handle');
        let active = false;
        let timer = null;
        let ghost = null;

        function begin(clientY) {
            active = true;
            row.classList.add('dragging');
            ghost = row.cloneNode(true);
            ghost.classList.add('ghost');
            ghost.classList.remove('dragging');
            const rect = row.getBoundingClientRect();
            ghost.style.width = `${rect.width}px`;
            ghost.style.left = `${rect.left}px`;
            document.body.append(ghost);
            positionGhost(clientY);
        }

        function positionGhost(clientY) {
            ghost.style.top = `${clientY - 24}px`;
        }

        function markTarget(clientY) {
            const others = [...list.children].filter(child => child !== row);
            others.forEach(child => child.classList.remove('drop-above'));
            const target = others.find(child => {
                const rect = child.getBoundingClientRect();
                return clientY < rect.top + rect.height / 2;
            });
            if (target) target.classList.add('drop-above');
            row.dataset.dropBefore = target ? target.dataset.id : '';
        }

        async function end() {
            clearTimeout(timer);
            if (!active) return;
            active = false;
            row.classList.remove('dragging');
            ghost?.remove();
            ghost = null;
            const before = row.dataset.dropBefore;
            [...list.children].forEach(child => child.classList.remove('drop-above'));
            const ids = schedule.queue.map(entry => entry.id);
            const from = ids.indexOf(item.id);
            ids.splice(from, 1);
            const insertAt = before ? ids.indexOf(Number(before)) : ids.length;
            ids.splice(insertAt < 0 ? ids.length : insertAt, 0, item.id);
            if (ids.join() === schedule.queue.map(entry => entry.id).join()) return;
            schedule.queue.sort((first, second) => ids.indexOf(first.id) - ids.indexOf(second.id));
            renderQueue();
            try {
                await api('queue/order', 'PUT', { ids });
                await reload();
            } catch (error) {
                message(`排序保存失败：${error.message}`, true);
                await reload();
            }
        }

        handle.addEventListener('pointerdown', event => {
            if (active) return;
            const y = event.clientY;
            if (event.pointerType === 'mouse') begin(y);
            else {
                timer = setTimeout(() => begin(y), 300);
                const cancel = moveEvent => {
                    if (Math.abs(moveEvent.clientY - y) > 10) {
                        clearTimeout(timer);
                        window.removeEventListener('pointermove', cancel);
                    }
                };
                window.addEventListener('pointermove', cancel);
            }
        });
        window.addEventListener('pointermove', event => {
            if (!active) return;
            event.preventDefault();
            positionGhost(event.clientY);
            markTarget(event.clientY);
        }, { passive: false });
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    }

    async function queueChange(id, data) {
        try {
            await api(`queue/${id}`, 'PUT', data);
            await reload();
        } catch (error) {
            message(`操作失败：${error.message}`, true);
        }
    }

    // ---------- 食物池弹窗（连续添加，已加入置灰） ----------

    function openQueuePicker() {
        const body = node('div', '', 'planning-dialog-body');
        const label = node('label', '搜索食物或品类');
        const search = node('input', '', 'form-input');
        search.type = 'search';
        search.placeholder = '输入食物或品类名称';
        label.append(search);
        const list = node('div', '', 'planning-queue-picker-list');
        body.append(label, list);
        body.append(node('p', '只显示未排敏且未入队的食物，可连续点选多个。', 'planning-hint'));
        const render = () => renderQueuePicker(search, list);
        search.addEventListener('input', render);
        search.addEventListener('keydown', event => {
            if (event.key === 'Enter') event.preventDefault();
        });
        const footer = node('div', '', 'planning-actions');
        footer.append(button('完成', closeDialog, 'planning-btn primary'));
        body.append(footer);
        openDialog('从食物池添加', body);
        render();
        search.focus();
    }

    function renderQueuePicker(search, list) {
        const query = (search.value || '').trim().toLocaleLowerCase();
        list.replaceChildren();
        const groups = new Map();
        boardFoods().filter(food => food.status === 'untouched' && !food.in_queue).forEach(food => {
            const key = `${food.category_emoji || '🍚'} ${food.category_name || '未分组'}${food.is_high_allergen ? ' ⚠️' : ''}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(food);
        });
        let matched = 0;
        groups.forEach((foods, groupName) => {
            const filtered = foods.filter(food => `${food.name} ${groupName}`.toLocaleLowerCase().includes(query));
            if (!filtered.length) return;
            matched += filtered.length;
            list.append(node('h3', groupName, 'planning-group-title'));
            const group = node('div', '', 'planning-chip-group');
            filtered.forEach(food => {
                group.append(button(food.name, async () => {
                    try {
                        await api('queue', 'POST', { food_id: food.id });
                        await reload();
                        toast(`已加入队列：${food.name}`);
                        render();
                    } catch (error) {
                        message(`添加失败：${error.message}`, true);
                    }
                }, 'planning-chip'));
            });
            list.append(group);
        });
        if (!matched) list.append(node('p', '没有匹配的未排敏食物，可到辅食库添加。', 'planning-hint'));
    }

    function boardFoods() {
        return schedule.board_foods || [];
    }

    // ---------- 冲突与移动 ----------

    function renderConflicts() {
        const bar = element('conflicts');
        bar.replaceChildren();
        if (!schedule.conflicts.length) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        schedule.conflicts.slice(0, 4).forEach(conflict => {
            bar.append(node('p', `⚠️「${conflict.foods[0]}」（${conflict.first.start} 起）与「${conflict.foods[1]}」（${conflict.second.start} 起）观察期重叠，建议间隔开`, 'planning-line'));
        });
    }

    function renderMovebar() {
        const bar = element('movebar');
        bar.replaceChildren();
        if (movingBlock === null) {
            bar.hidden = true;
            return;
        }
        const block = schedule.blocks.find(item => item.id === movingBlock);
        if (!block) {
            movingBlock = null;
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        bar.append(node('span', `正在移动「${foodName(block.food_id)}」（${block.start_date} 起 ${block.days} 天）：点击日历上的目标日期放下`, 'planning-line'));
        const actions = node('div', '', 'planning-actions');
        actions.append(button('取消移动', () => {
            movingBlock = null;
            renderMovebar();
            renderCalendar();
        }));
        bar.append(actions);
    }

    async function changeBlock(block, data) {
        try {
            const result = await api(`blocks/${block.id}`, 'PUT', data);
            applySchedule(result);
            toast('计划已更新');
        } catch (error) {
            message(`操作失败：${error.message}`, true);
        }
    }

    // ---------- 日历（苹果日历风格：日期数字 + 彩色圆点，详情点选后在下方展开） ----------

    function itemsForDate(day) {
        const blocks = schedule.blocks
            .filter(block => day >= block.start_date && day <= addDays(block.start_date, block.days - 1))
            .map(block => ({
                kind: 'block', block,
                offset: Math.round((new Date(day + 'T00:00:00') - new Date(block.start_date + 'T00:00:00')) / 86400000)
            }));
        const rounds = (schedule.rounds || [])
            .filter(item => day >= item.start_date && day <= addDays(item.start_date, item.observe_days - 1))
            .map(item => ({
                kind: 'round', item,
                offset: Math.round((new Date(day + 'T00:00:00') - new Date(item.start_date + 'T00:00:00')) / 86400000)
            }));
        const pauses = schedule.pauses
            .filter(item => day >= item.start_date && day <= item.end_date)
            .map(pause => ({ kind: 'pause', pause }));
        const normals = schedule.normals
            .filter(item => day >= item.start_date && day <= addDays(item.start_date, item.days - 1))
            .map(plan => ({ kind: 'normal', plan }));
        return [...rounds, ...blocks, ...pauses, ...normals];
    }

    function renderCalendar() {
        const container = element('calendar');
        container.replaceChildren();
        const today = schedule.today;
        if (!monthCursor) monthCursor = today.slice(0, 7);
        const [year, month] = monthCursor.split('-').map(Number);
        element('calendar-title').textContent = `${year}年${month}月`;
        const first = new Date(year, month - 1, 1);
        const offset = (first.getDay() + 6) % 7;
        const days = new Date(year, month, 0).getDate();
        weekdays.forEach(label => container.append(node('div', label, 'planning-wd')));
        for (let blank = 0; blank < offset; blank += 1) container.append(node('div', '', 'planning-cell blank'));
        for (let day = 1; day <= days; day += 1) {
            const pad = String(day).padStart(2, '0');
            const dateStr = `${monthCursor}-${pad}`;
            const cell = node('button', '', 'planning-cell');
            cell.type = 'button';
            if (dateStr === today) cell.classList.add('today');
            if (dateStr < today) cell.classList.add('past');
            if (selectedDay === dateStr) cell.classList.add('selected');
            cell.append(node('span', String(day), 'planning-day'));
            const dots = node('span', '', 'planning-dots');
            itemsForDate(dateStr).slice(0, 3).forEach(item => {
                const dot = node('i', '', 'planning-dot');
                if (item.kind === 'round') dot.classList.add('round');
                else if (item.kind === 'block') dot.classList.add(paletteMap[item.block.food_id] || 'seg-0');
                else if (item.kind === 'pause') dot.classList.add('pause');
                else dot.classList.add('normal');
                dots.append(dot);
            });
            cell.append(dots);
            cell.addEventListener('click', () => {
                if (movingBlock !== null) {
                    moveBlockTo(dateStr);
                    return;
                }
                selectedDay = dateStr;
                renderCalendar();
                renderDayDetail();
            });
            container.append(cell);
        }
    }

    function weekdayLabel(dateStr) {
        const index = (new Date(dateStr + 'T00:00:00').getDay() + 6) % 7;
        return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][index];
    }

    function renderDayDetail() {
        const container = element('day');
        if (!container) return;
        container.replaceChildren();
        if (!selectedDay) {
            container.append(node('p', '点上面的日期，查看当天的排敏安排。', 'planning-hint'));
            return;
        }
        const future = selectedDay > schedule.today;
        const head = node('div', '', 'planning-day-head');
        head.append(node('strong', `${Number(selectedDay.slice(8))}日 · ${weekdayLabel(selectedDay)}${selectedDay === schedule.today ? ' · 今天' : ''}`, 'planning-day-title'));
        container.append(head);
        const items = itemsForDate(selectedDay);
        if (!items.length) container.append(node('p', '这天没有安排。', 'planning-line'));
        items.forEach(item => {
            const row = node('div', '', 'planning-day-row');
            const dot = node('span', '', 'planning-agenda-dot');
            let text = '';
            if (item.kind === 'round') {
                dot.classList.add('round');
                text = `${item.item.food_name} · 排敏观察中 · 第${item.offset + 1}/${item.item.observe_days}天（${item.item.start_date.slice(5).replace('-', '/')} 起）`;
            } else if (item.kind === 'block') {
                dot.classList.add(paletteMap[item.block.food_id] || 'seg-0');
                text = `${foodName(item.block.food_id)} · 第${item.offset + 1}/${item.block.days}天` +
                    `${item.block.pinned ? ' · 已固定📌' : ''}${item.block.stale ? ' · 已失效' : ''}`;
            } else if (item.kind === 'pause') {
                dot.classList.add('pause');
                text = `⏸ 暂停排敏${item.pause.reason ? ` · ${item.pause.reason}` : ''}`;
            } else {
                dot.classList.add('normal');
                text = `${foodName(item.plan.food_id)} · 常规计划`;
            }
            row.append(dot);
            row.append(node('span', text, 'planning-day-text'));
            const actions = node('div', '', 'planning-day-actions');
            if (item.kind === 'block' && !item.block.stale && future) {
                actions.append(button('移动', () => {
                    movingBlock = item.block.id;
                    renderMovebar();
                    toast('已选中，请点击日历上的目标日期');
                }));
                actions.append(button('天数+', () => changeBlock(item.block, { days: Math.min(14, item.block.days + 1) })));
                if (item.block.days > 1) actions.append(button('天数-', () => changeBlock(item.block, { days: item.block.days - 1 })));
                if (item.block.pinned) actions.append(button('取消固定', () => changeBlock(item.block, { pinned: false })));
                actions.append(button('删除', () => run(`删除「${foodName(item.block.food_id)}」的计划？食物将回到排敏队列末尾。`, () => api(`blocks/${item.block.id}`, 'DELETE'))));
            } else if (item.kind === 'pause') {
                actions.append(button('删除', () => run('删除这个暂停段？', () => api(`pauses/${item.pause.id}`, 'DELETE'))));
            } else if (item.kind === 'normal') {
                actions.append(button('删除', () => run('删除这条常规计划？', () => api(`normals/${item.plan.id}`, 'DELETE'))));
            }
            if (actions.children.length) row.append(actions);
            container.append(row);
        });
        if (future) {
            const addRow = node('div', '', 'planning-day-add');
            addRow.append(button('＋ 常规计划（正常食物）', () => normalDialog(selectedDay)));
            addRow.append(button('⏸ 划暂停段', () => pauseDialog(selectedDay)));
            container.append(addRow);
        }
    }

    async function moveBlockTo(dateStr) {
        const block = schedule.blocks.find(item => item.id === movingBlock);
        if (!block) {
            movingBlock = null;
            renderMovebar();
            return;
        }
        if (dateStr <= schedule.today) {
            message('计划只能移动到今天之后', true);
            return;
        }
        try {
            const result = await api(`blocks/${block.id}`, 'PUT', { start_date: dateStr });
            applySchedule(result);
            movingBlock = null;
            selectedDay = dateStr;
            renderCalendar();
            renderDayDetail();
            renderMovebar();
            toast(schedule.conflicts.length ? '已移动并固定 📌（存在观察期重叠，可一键重排）' : '已移动并固定 📌');
        } catch (error) {
            message(`移动失败：${error.message}`, true);
        }
    }

    // ---------- 排期一览（日历的完整文字版） ----------

    function dateRange(start, days) {
        const end = addDays(start, days - 1);
        const short = value => value.slice(5).replace('-', '/');
        return days <= 1 ? short(start) : `${short(start)}–${short(end)}`;
    }

    function renderAgenda() {
        const container = element('agenda');
        if (!container) return;
        container.replaceChildren();
        const rows = [];
        (schedule.rounds || []).forEach(item => {
            rows.push({
                sort: item.start_date, color: 'round',
                text: `${dateRange(item.start_date, item.observe_days)} ${item.food_name} · 排敏观察中`
            });
        });
        schedule.blocks.forEach(block => {
            rows.push({
                sort: block.start_date,
                color: paletteMap[block.food_id] || 'seg-0',
                text: `${dateRange(block.start_date, block.days)} ${foodName(block.food_id)} · 观察${block.days}天${block.pinned ? ' · 已固定📌' : ''}${block.stale ? ' · 已失效' : ''}`
            });
        });
        schedule.pauses.forEach(pause => {
            const days = Math.round((new Date(pause.end_date) - new Date(pause.start_date)) / 86400000) + 1;
            rows.push({ sort: pause.start_date, color: 'pause', text: `${dateRange(pause.start_date, days)} ⏸ 暂停排敏${pause.reason ? ` · ${pause.reason}` : ''}` });
        });
        schedule.normals.forEach(plan => {
            rows.push({ sort: plan.start_date, color: 'normal', text: `${dateRange(plan.start_date, plan.days)} ${foodName(plan.food_id)} · 常规计划` });
        });
        rows.sort((first, second) => first.sort.localeCompare(second.sort));
        if (!rows.length) {
            container.append(node('p', '还没有任何排期。可先在上方维护队列，然后自动生成排期。', 'planning-hint'));
            return;
        }
        rows.forEach(row => {
            const line = node('div', '', 'planning-agenda-row');
            line.append(node('span', '', 'planning-agenda-dot ' + row.color));
            line.append(node('span', row.text, 'planning-agenda-text'));
            container.append(line);
        });
    }

    function addDays(value, count) {
        const date = new Date(value + 'T00:00:00');
        date.setDate(date.getDate() + count);
        return iso(date);
    }

    function pauseDialog(dateStr) {
        const body = node('div', '', 'planning-dialog-body');
        const startLabel = node('label', '开始日期');
        const start = node('input', '', 'form-input');
        start.type = 'date';
        start.value = dateStr;
        startLabel.append(start);
        const endLabel = node('label', '结束日期');
        const end = node('input', '', 'form-input');
        end.type = 'date';
        end.value = dateStr;
        endLabel.append(end);
        const reasonLabel = node('label', '原因（选填）');
        const reason = node('input', '', 'form-input');
        reason.maxLength = 50;
        reason.placeholder = '例如：出去玩 / 打疫苗';
        reasonLabel.append(reason);
        body.append(startLabel, endLabel, reasonLabel);
        body.append(node('p', '暂停期间不安排新食物排敏，排期自动绕开。', 'planning-hint'));
        const actions = node('div', '', 'planning-actions');
        actions.append(button('取消', closeDialog));
        actions.append(button('保存暂停段', async () => {
            try {
                const result = await api('pauses', 'POST', {
                    start_date: start.value, end_date: end.value, reason: reason.value
                });
                applySchedule(result);
                closeDialog();
                toast('已添加暂停段');
            } catch (error) {
                message(`保存失败：${error.message}`, true);
            }
        }, 'planning-btn primary'));
        body.append(actions);
        openDialog('划暂停段', body);
    }

    function normalDialog(dateStr) {
        const body = node('div', '', 'planning-dialog-body');
        if (!schedule.normal_foods.length) {
            body.append(node('p', '还没有已正常的食物。先完成排敏后才能加入常规计划。', 'planning-hint'));
            const actions = node('div', '', 'planning-actions');
            actions.append(button('关闭', closeDialog));
            body.append(actions);
            openDialog('常规计划', body);
            return;
        }
        const group = node('div', '', 'planning-chip-group');
        const chosen = { food: null };
        schedule.normal_foods.forEach(food => {
            const chip = button(food.name, () => {
                chosen.food = food.id;
                [...group.children].forEach(child => child.classList.remove('active'));
                chip.classList.add('active');
            }, 'planning-chip');
            group.append(chip);
        });
        body.append(node('p', '常规计划只能选「正常」食物，未排敏食物请加入排敏队列。', 'planning-hint'));
        body.append(group);
        const daysLabel = node('label', '连续天数');
        const daysGroup = node('div', '', 'planning-chip-group');
        const chosenDays = { days: 1 };
        [1, 2, 3].forEach(days => {
            const chip = button(`${days} 天`, () => {
                chosenDays.days = days;
                [...daysGroup.children].forEach(child => child.classList.remove('active'));
                chip.classList.add('active');
            }, 'planning-chip' + (days === 1 ? ' active' : ''));
            daysGroup.append(chip);
        });
        daysLabel.append(daysGroup);
        body.append(daysLabel);
        const actions = node('div', '', 'planning-actions');
        actions.append(button('取消', closeDialog));
        actions.append(button('保存常规计划', async () => {
            if (!chosen.food) {
                message('请选择一种食物', true);
                return;
            }
            try {
                const result = await api('normals', 'POST', {
                    food_id: chosen.food, start_date: dateStr, days: chosenDays.days
                });
                applySchedule(result);
                closeDialog();
                toast('已添加常规计划');
            } catch (error) {
                message(`保存失败：${error.message}`, true);
            }
        }, 'planning-btn primary'));
        body.append(actions);
        openDialog(`常规计划 · ${dateStr}`, body);
    }

    // ---------- 通用 ----------

    function applySchedule(result) {
        schedule = { ...schedule, ...result };
        paletteMap = buildColorMap();
        renderQueue();
        renderConflicts();
        renderMovebar();
        renderCalendar();
        renderDayDetail();
        renderAgenda();
    }

    async function run(text, action) {
        if (!window.confirm(text)) return;
        try {
            const result = await action();
            if (result && result.blocks) applySchedule(result);
            else await reload();
            toast('操作成功');
        } catch (error) {
            message(`操作失败：${error.message}`, true);
        }
    }

    async function reload() {
        message('正在加载排期…');
        try {
            const result = await api('schedule');
            const board = await api('board');
            result.board_foods = board.foods;
            schedule = result;
            paletteMap = buildColorMap();
            message();
            renderQueue();
            renderConflicts();
            renderMovebar();
            renderCalendar();
            renderDayDetail();
            renderAgenda();
        } catch (error) {
            message(`加载失败：${error.message}`, true);
        }
    }

    function openDialog(title, body) {
        element('dialog-title').textContent = title;
        element('dialog-body').replaceChildren(body);
        element('overlay').hidden = false;
    }

    function closeDialog() {
        element('overlay').hidden = true;
    }

    element('auto').addEventListener('click', () => run('按队列顺序自动生成排期？将接在现有排期之后，绕开暂停段。', () => api('schedule/auto', 'POST')));
    element('repack').addEventListener('click', async () => {
        if (!window.confirm('把未固定的未来排期恢复为首尾相接？固定📌的计划和暂停段不会被移动。')) return;
        const before = schedule.blocks.map(block => `${block.id}:${block.start_date}`).join('|');
        try {
            const result = await api('schedule/repack', 'POST');
            applySchedule(result);
            const after = schedule.blocks.map(block => `${block.id}:${block.start_date}`).join('|');
            toast(after === before ? '排期本来就连着，无需调整' : '已恢复首尾相接');
        } catch (error) {
            message(`操作失败：${error.message}`, true);
        }
    });
    element('queue-add').addEventListener('click', openQueuePicker);
    element('prev').addEventListener('click', () => { monthCursor = shiftMonth(-1); renderCalendar(); });
    element('next').addEventListener('click', () => { monthCursor = shiftMonth(1); renderCalendar(); });
    element('overlay').addEventListener('click', event => {
        if (event.target === element('overlay')) closeDialog();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !element('overlay').hidden) closeDialog();
    });

    function shiftMonth(count) {
        const [year, month] = monthCursor.split('-').map(Number);
        const date = new Date(year, month - 1 + count, 1);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    const elderButton = element('elder');
    function applyElder(on) {
        document.body.classList.toggle('elder', on);
        elderButton.textContent = on ? 'A- 标准' : 'A+ 大字';
    }
    elderButton.addEventListener('click', () => {
        const on = !document.body.classList.contains('elder');
        applyElder(on);
        try { localStorage.setItem('elder-mode', on ? '1' : '0'); } catch (error) {}
    });
    try { applyElder(localStorage.getItem('elder-mode') === '1'); } catch (error) { applyElder(false); }

    reload();
})();
