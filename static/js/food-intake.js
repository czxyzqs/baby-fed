(() => {
    const element = name => document.getElementById(`food-intake-${name}`);
    const meals = { breakfast: '早餐', lunch: '午餐', snack: '下午茶', dinner: '晚餐' };
    const amounts = ['一勺尖', '一勺', '两勺', '三勺', '半碗', '一碗'];
    const ratings = { 喜欢: '😋 喜欢', 一般: '😐 一般', 拒绝: '🥴 拒绝' };
    const statuses = { untouched: '未排敏', screening: '排敏中', normal: '正常', allergic: '过敏' };
    let context = null;
    let blocks = [];
    let selectedDate = '';
    let selectedMeal = '';
    let dirty = false;
    let busy = false;
    let pickerIndex = null;
    let opener = null;
    let historyVersion = 0;

    function today() {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    function suggestedMeal() {
        const hour = Number(new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23'
        }).format(new Date()));
        return hour < 11 ? 'breakfast' : hour < 14 ? 'lunch' : hour < 17 ? 'snack' : 'dinner';
    }

    async function api(path, data) {
        const response = await fetch(`/api/${path}`, {
            method: data === undefined ? 'GET' : 'POST',
            cache: 'no-store',
            headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试');
        return result;
    }

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    function button(text, handler, className = '') {
        const result = node('button', text, className);
        result.type = 'button';
        result.addEventListener('click', handler);
        return result;
    }

    function message(text = '', error = false) {
        element('message').textContent = text;
        element('message').hidden = !text;
        element('message').dataset.error = String(error);
        if (error) element('message').scrollIntoView({ block: 'nearest' });
    }

    function setBusy(value) {
        busy = value;
        element('fields').disabled = value;
        element('close').disabled = value;
        element('modal').setAttribute('aria-busy', String(value));
    }

    function discard() {
        return !dirty || window.confirm('有尚未保存的辅食记录，确定放弃这些修改吗？');
    }

    function close() {
        if (busy || !discard()) return false;
        element('modal').classList.remove('active');
        document.body.style.overflow = '';
        dirty = false;
        opener?.focus();
        return true;
    }

    function foodFor(block) {
        return context.foods.find(food => food.id === block.food_id);
    }

    function isExisting(block) {
        return block.id != null && block.original_food_id === block.food_id;
    }

    function defaultMode(food) {
        return food.status === 'untouched' ? 'start' : food.status === 'allergic' ? 'only' : 'keep';
    }

    function suggestedAmount(food) {
        return amounts[Math.min(Math.max(food.position, 1), 4) - 1];
    }

    function selectMeal() {
        blocks = context.entries.filter(entry => entry.meal === selectedMeal).map(entry => ({
            ...entry, original_food_id: entry.food_id, mode: 'keep'
        }));
        dirty = false;
        element('picker').hidden = true;
        element('title').textContent = blocks.length ? '编辑辅食记录' : '添加辅食记录';
        renderBlocks();
    }

    async function loadEditor(dateValue, mealValue) {
        setBusy(true);
        message('正在加载食物和本餐记录…');
        try {
            const result = await api(`entries?date=${encodeURIComponent(dateValue)}`);
            context = result;
            selectedDate = dateValue;
            selectedMeal = mealValue;
            element('date').value = selectedDate;
            element('meal').value = selectedMeal;
            selectMeal();
            message();
        } catch (error) {
            element('date').value = selectedDate || dateValue;
            element('meal').value = selectedMeal;
            message(`加载失败：${error.message}。可点击“重新载入本餐”重试。`, true);
        } finally {
            setBusy(false);
        }
    }

    async function open(dateValue = today(), mealValue = null) {
        if (busy || (element('modal').classList.contains('active') && !discard())) return;
        opener = document.activeElement;
        context = null;
        blocks = [];
        dirty = false;
        selectedDate = dateValue;
        selectedMeal = mealValue || (dateValue === today() ? suggestedMeal() : '');
        element('date').max = today();
        element('date').value = selectedDate;
        element('meal').value = selectedMeal;
        element('picker').hidden = true;
        element('blocks').replaceChildren();
        element('add').disabled = true;
        element('save').disabled = true;
        element('empty').textContent = '';
        element('modal').classList.add('active');
        document.body.style.overflow = 'hidden';
        await loadEditor(selectedDate, selectedMeal);
        element('date').focus();
    }

    function choices(label, options, selected, onChange) {
        const group = node('div', '', 'food-intake-options');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', label);
        options.forEach(([value, text]) => {
            const choice = button(text, () => onChange(value));
            choice.setAttribute('aria-pressed', String(selected === value));
            choice.dataset.choice = `${label}:${value}`;
            group.append(choice);
        });
        return group;
    }

    function renderBlocks() {
        const container = element('blocks');
        const focusedBlock = document.activeElement.closest('.food-intake-block');
        const focusedIndex = focusedBlock ? [...container.children].indexOf(focusedBlock) : -1;
        const focusedChoice = document.activeElement.dataset.choice;
        container.replaceChildren();
        element('empty').textContent = !selectedMeal ? '补记过去日期时，请手动选择餐次。' :
            blocks.length ? '' : '本餐还没有食物，点击“＋ 新增食物”从辅食库选择。';
        element('add').disabled = !context || !selectedMeal;
        element('save').disabled = !context || !selectedMeal;
        blocks.forEach((block, index) => {
            const food = foodFor(block);
            const card = node('section', '', 'food-intake-block');
            const header = node('div', '', 'food-intake-block-header');
            header.append(button(`${block.food_name} · 更换`, () => showPicker(index)));
            const remove = button('×', () => {
                blocks.splice(index, 1);
                dirty = true;
                element('picker').hidden = true;
                renderBlocks();
            });
            remove.setAttribute('aria-label', `移除${block.food_name}`);
            header.append(remove);
            card.append(header);
            const currentStatus = food ? `当前状态：${statuses[food.status]}` : '食物已从辅食库删除，保留历史名称';
            card.append(node('p', currentStatus, 'food-intake-hint'));
            if (food?.status === 'screening') {
                const historical = selectedDate < food.start_date;
                card.append(node('p', historical ? '此日期早于当前排敏轮次，仅补记摄入，不计入本轮进度。' :
                    `已记录 ${food.eaten_days}/${food.observe_days} 个进食日；本次为第 ${food.position} 个进食日，建议量：${suggestedAmount(food)}。不会自动判定耐受。`, 'food-intake-hint'));
            }
            if (!isExisting(block) && food && ['untouched', 'allergic'].includes(food.status)) {
                const options = food.status === 'untouched' ?
                    [['start', '开始排敏（默认观察3天）'], ['normal', '已耐受，直接记正常']] :
                    [['retry', '按新一轮排敏记录'], ['only', '仅记录（误食等）']];
                if (food.status === 'allergic') card.append(node('p', '⚠️ 此食物已标记过敏，请确认记录方式。', 'food-intake-hint'));
                card.append(choices('排敏记录方式', options, block.mode, value => {
                    block.mode = value;
                    if (value === 'normal' && block.auto_amount) block.amount = '';
                    if (!block.amount && ['start', 'retry'].includes(value)) {
                        block.amount = amounts[0];
                        block.auto_amount = true;
                    }
                    dirty = true;
                    renderBlocks();
                }));
            }
            card.append(node('h3', '进食量（必选）'));
            card.append(choices('进食量', amounts.map(value => [value, value]), block.amount, value => {
                block.amount = value;
                block.auto_amount = false;
                dirty = true;
                renderBlocks();
            }));
            card.append(node('h3', '接受度（选填，再点可取消）'));
            card.append(choices('接受度', Object.entries(ratings), block.rating, value => {
                block.rating = block.rating === value ? null : value;
                dirty = true;
                renderBlocks();
            }));
            const label = node('label', '备注（选填）');
            const input = node('input', '', 'form-input');
            input.type = 'text';
            input.maxLength = 500;
            input.value = block.note || '';
            input.placeholder = '例如：蒸熟压泥';
            input.addEventListener('input', () => {
                block.note = input.value;
                dirty = true;
            });
            label.append(input);
            card.append(label);
            container.append(card);
        });
        if (focusedIndex >= 0 && focusedChoice) {
            const replacement = [...(container.children[focusedIndex]?.querySelectorAll('[data-choice]') || [])]
                .find(control => control.dataset.choice === focusedChoice);
            replacement?.focus({ preventScroll: true });
        }
    }

    function showPicker(index = null) {
        pickerIndex = index;
        element('search').value = '';
        element('category').replaceChildren(new Option('全部品类', ''));
        context.categories.forEach(category => {
            element('category').add(new Option(`${category.emoji} ${category.name}`, String(category.id)));
        });
        element('picker').hidden = false;
        renderPicker();
        element('search').focus();
        element('picker').scrollIntoView({ block: 'nearest' });
    }

    function renderPicker() {
        const query = element('search').value.trim().toLocaleLowerCase();
        const categoryFilter = element('category').value;
        const container = element('picker-list');
        container.replaceChildren();
        context.categories.forEach(category => {
            if (categoryFilter && String(category.id) !== categoryFilter) return;
            const foods = context.foods.filter(food => food.category_id === category.id &&
                `${food.name} ${category.name}`.toLocaleLowerCase().includes(query));
            if (!foods.length) return;
            container.append(node('h3', `${category.emoji} ${category.name}${category.is_high_allergen ? ' ⚠️ 高致敏品类' : ''}`));
            const group = node('div', '', 'food-intake-options');
            foods.forEach(food => {
                const duplicate = blocks.some((block, index) => index !== pickerIndex && block.food_id === food.id);
                const select = button(`${food.name} · ${statuses[food.status]}${duplicate ? '（已添加）' : ''}`, () => {
                    const previous = pickerIndex === null ? null : blocks[pickerIndex];
                    const block = {
                        id: previous?.id ?? null,
                        original_food_id: previous?.original_food_id ?? null,
                        food_id: food.id, food_name: food.name,
                        amount: previous ? previous.amount :
                            food.status === 'screening' && selectedDate >= food.start_date ? suggestedAmount(food) :
                                food.status === 'untouched' ? amounts[0] : '',
                        rating: previous?.rating ?? null, note: previous?.note ?? '', mode: defaultMode(food)
                    };
                    block.auto_amount = !previous && ['untouched', 'screening'].includes(food.status);
                    if (pickerIndex === null) blocks.push(block);
                    else blocks[pickerIndex] = block;
                    dirty = true;
                    element('picker').hidden = true;
                    renderBlocks();
                    element('blocks').children[pickerIndex ?? blocks.length - 1].scrollIntoView({ block: 'nearest' });
                });
                select.disabled = duplicate;
                group.append(select);
            });
            container.append(group);
        });
        if (!container.children.length) container.append(node('p', '没有匹配的食物，可调整搜索或前往辅食库添加。', 'food-intake-hint'));
    }

    async function save(event) {
        event.preventDefault();
        if (busy || !context || !selectedMeal) return;
        if (blocks.some(block => !amounts.includes(block.amount))) {
            message('请为每种食物选择进食量。', true);
            return;
        }
        const oldEntries = context.entries.filter(entry => entry.meal === selectedMeal);
        if (!blocks.length && !oldEntries.length) {
            message('请先添加至少一种食物。', true);
            return;
        }
        const removed = oldEntries.some(entry => !blocks.some(block => block.id === entry.id));
        if (removed && !window.confirm('保存后会删除从本餐移除的记录，确定保存吗？')) return;
        setBusy(true);
        message('正在保存本餐…');
        try {
            context = await api('meals', {
                date: selectedDate, meal: selectedMeal,
                revision: context.revisions[selectedMeal],
                entries: blocks.map(block => ({
                    id: block.id, food_id: block.food_id, amount: block.amount,
                    rating: block.rating, note: block.note, mode: block.mode
                }))
            });
            dirty = false;
            element('history-date').value = selectedDate;
            await loadHistory();
            setBusy(false);
            close();
            showToast(`已保存${meals[selectedMeal]}辅食记录`);
        } catch (error) {
            message(`保存失败：${error.message}。输入已保留。`, true);
        } finally {
            setBusy(false);
        }
    }

    async function loadHistory() {
        const version = ++historyVersion;
        const dateValue = element('history-date').value;
        element('history-message').textContent = '正在加载辅食记录…';
        element('history-list').replaceChildren();
        try {
            const result = await api(`entries?date=${encodeURIComponent(dateValue)}`);
            if (version !== historyVersion) return;
            element('history-message').textContent = result.entries.length ? '' : '这一天还没有辅食记录。';
            Object.entries(meals).forEach(([meal, label]) => {
                const entries = result.entries.filter(entry => entry.meal === meal);
                const card = node('article', '', 'food-intake-meal-card');
                card.append(node('h3', label));
                entries.forEach(entry => {
                    card.append(node('p', `${entry.food_name} · ${entry.amount}${entry.rating ? ` · ${ratings[entry.rating]}` : ''}${entry.note ? ` · ${entry.note}` : ''}`));
                });
                card.append(button(entries.length ? `编辑${label}` : `＋ 记录${label}`, () => open(dateValue, meal)));
                element('history-list').append(card);
            });
        } catch (error) {
            if (version !== historyVersion) return;
            element('history-message').textContent = `辅食记录加载失败：${error.message}`;
            element('history-list').append(button('重试加载辅食记录', loadHistory));
        }
    }

    element('date').addEventListener('change', () => {
        const dateValue = element('date').value;
        if (!dateValue || dateValue > today() || !discard()) {
            element('date').value = selectedDate;
            return;
        }
        loadEditor(dateValue, dateValue === today() ? suggestedMeal() : '');
    });
    element('meal').addEventListener('change', () => {
        if (!discard()) {
            element('meal').value = selectedMeal;
            return;
        }
        loadEditor(selectedDate, element('meal').value);
    });
    element('reload').addEventListener('click', () => {
        if (discard()) loadEditor(selectedDate, selectedMeal);
    });
    element('add').addEventListener('click', () => showPicker());
    element('close').addEventListener('click', close);
    element('cancel').addEventListener('click', close);
    element('form').addEventListener('submit', save);
    element('search').addEventListener('input', renderPicker);
    element('search').addEventListener('keydown', event => {
        if (event.key === 'Enter') event.preventDefault();
    });
    element('category').addEventListener('change', renderPicker);
    element('picker-cancel').addEventListener('click', () => { element('picker').hidden = true; });
    element('library').addEventListener('click', event => {
        if (busy || !discard()) event.preventDefault();
        else dirty = false;
    });
    element('modal').addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
        if (event.key === 'Tab') {
            const controls = [...element('modal').querySelectorAll('button, input, select, a[href]')]
                .filter(control => !control.matches(':disabled') && control.getClientRects().length);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
    });
    window.addEventListener('beforeunload', event => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = '';
    });
    window.addEventListener('pageshow', event => { if (event.persisted) loadHistory(); });
    element('history-date').value = today();
    element('history-date').max = today();
    element('history-date').addEventListener('change', loadHistory);
    window.foodIntake = { open, close };
    loadHistory();
})();
