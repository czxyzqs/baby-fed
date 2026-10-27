(() => {
    const element = name => document.getElementById(`food-intake-${name}`);
    const meals = { breakfast: '早餐', lunch: '午餐', snack: '下午茶', dinner: '晚餐' };
    const amounts = ['一勺尖', '一勺', '两勺', '三勺', '半碗', '一碗'];
    // 备餐按份记录的量值（与后端 PORTION_AMOUNTS 对齐）；编辑器里作为额外选项呈现
    const portionAmounts = ['0.5份', '1份', '1.5份', '2份', '2.5份', '3份', '3.5份', '4份'];
    const gramAmount = value => (/^\d{1,2}g$/.test(value) ? value : null);
    const allAmounts = [...amounts, ...portionAmounts];
    const portionOfV = value => (typeof value === 'string' && value.endsWith('份') ? Number(value.slice(0, -1)) : null);
    const gramOfV = value => (typeof value === 'string' && value.endsWith('g') ? Number(value.slice(0, -1)) : null);
    // 备餐批次与克模式（谷薯类）：决定每种食物的计量单位
    let batchByFood = {};
    const isGramFood = food => {
        if (!food || batchByFood[food.id]) return false;
        const category = context.categories.find(item => item.id === food.category_id);
        return category?.name === '谷薯类';
    };
    function unitAwareAmount(food) {
        if (batchByFood[food.id]) return '1份';
        if (isGramFood(food)) return '6g';
        return amounts[Math.min(Math.max(food.position || 1, 1), 4) - 1];
    }
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
        return unitAwareAmount(food);
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

    async function prefillPlans() {
        // 本餐还没有记录时，把当天计划中尚未记录的食物自动成块（BR-08）
        if (blocks.length || !selectedMeal) return;
        let plans;
        try {
            const result = await api(`screening/plans?date=${encodeURIComponent(selectedDate)}`);
            plans = result.items || [];
        } catch (error) {
            return; // 计划加载失败不影响手动记录
        }
        const recorded = new Set(context.entries
            .filter(entry => entry.meal === selectedMeal)
            .map(entry => entry.food_id));
        // 计划餐次可能是多选（逗号分隔）或旧值 both/all（午晚两餐）
        const planMeals = plan => (plan.meal === 'both' || plan.meal === 'all')
            ? ['lunch', 'dinner']
            : String(plan.meal || '').split(',').filter(Boolean);
        plans = plans.filter(plan => !recorded.has(plan.food_id) &&
            !blocks.some(block => block.food_id === plan.food_id) &&
            planMeals(plan).includes(selectedMeal));
        if (!plans.length) return;
        plans.forEach(plan => {
            const starting = plan.is_new && !plan.started;
            blocks.push({
                id: null, original_food_id: null,
                food_id: plan.food_id, food_name: plan.food_name,
                amount: starting ? amounts[0] : '',
                rating: null, note: '',
                mode: starting ? 'start' : 'keep',
                auto_amount: starting
            });
        });
        dirty = true;
        element('title').textContent = '添加辅食记录';
        renderBlocks();
    }

    async function loadEditor(dateValue, mealValue) {
        setBusy(true);
        message('正在加载食物和本餐记录…');
        try {
            const [result, prepData] = await Promise.all([
                api(`entries?date=${encodeURIComponent(dateValue)}`),
                fetch('/api/prep/overview', { cache: 'no-store' })
                    .then(response => response.ok ? response.json() : null).catch(() => null)
            ]);
            context = result;
            batchByFood = {};
            (prepData?.batches || []).forEach(batch => { batchByFood[batch.food_id] = batch; });
            const mealTimes = context.entries
                .filter(entry => entry.meal === mealValue && entry.eaten_time)
                .map(entry => entry.eaten_time).sort();
            element('time').value = mealTimes[0] || '';
            selectedDate = dateValue;
            selectedMeal = mealValue;
            element('date').value = selectedDate;
            element('meal').value = selectedMeal;
            selectMeal();
            await prefillPlans();
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
        // 从记录页的餐次卡片进入时日期餐次已知，隐藏选择器，标题直接说明
        const contextKnown = Boolean(mealValue);
        element('date-meal').hidden = contextKnown;
        element('modal').classList.add('active');
        document.body.style.overflow = 'hidden';
        await loadEditor(selectedDate, selectedMeal);
        if (contextKnown) {
            const [month, day] = selectedDate.slice(5).split('-');
            element('title').textContent = `${meals[mealValue]} · ${Number(month)}月${Number(day)}日`;
        }
        element('date').focus();
    }

    function stepperControl(get, set, min, max, step, format) {
        const row = node('div', '', 'food-intake-stepper');
        const refresh = () => { value.textContent = format(get()); };
        const minus = button('−', () => { if (get() - step >= min) { set(Math.round((get() - step) * 10) / 10); refresh(); } });
        const value = node('span', format(get()), 'food-intake-stepper-value');
        const plus = button('＋', () => { if (get() + step <= max) { set(Math.round((get() + step) * 10) / 10); refresh(); } });
        row.append(minus, value, plus);
        return row;
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
            const foodInfo = context.foods.find(item => item.id === block.food_id);
            const batch = batchByFood[block.food_id];
            if (batch) {
                // 备餐食物按份：步进器 + 余量提示
                if (portionOfV(block.amount) == null && block.amount !== '0份') block.amount = '1份';
                card.append(stepperControl(
                    () => portionOfV(block.amount) ?? 1,
                    value => { block.amount = `${value}份`; block.auto_amount = false; dirty = true; },
                    0, 4, 0.5, value => (value ? `${value}份` : '不吃')
                ));
                card.append(node('p',
                    batch.exhausted ? '此批次已用完，仍按份记录（不扣库存）。'
                        : `剩${batch.portions_left}份${batch.grams_per_portion ? ` · 每份约${batch.grams_per_portion}g` : ''}`,
                    'food-intake-hint'));
            } else if (isGramFood(foodInfo)) {
                // 干粉主食按克
                if (gramOfV(block.amount) == null) block.amount = '6g';
                card.append(stepperControl(
                    () => gramOfV(block.amount) ?? 6,
                    value => { block.amount = `${value}g`; block.auto_amount = false; dirty = true; },
                    2, 30, 1, value => `${value}g`
                ));
            } else {
                const options = [...amounts,
                    ...portionAmounts.filter(value => value === block.amount),
                    ...(gramAmount(block.amount) ? [block.amount] : [])];
                card.append(choices('进食量', options.map(value => [value, value]), block.amount, value => {
                    block.amount = value;
                    block.auto_amount = false;
                    dirty = true;
                    renderBlocks();
                }));
            }
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
        if (blocks.some(block => !allAmounts.includes(block.amount) && !gramAmount(block.amount))) {
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
        // 日期/餐次改了 = 整餐移动：以表单当前值为目标，原位置保存时清空
        const targetDate = element('date').value;
        const targetMeal = element('meal').value;
        const moving = targetDate !== selectedDate || targetMeal !== selectedMeal;
        setBusy(true);
        message('正在保存本餐…');
        try {
            let targetRevisions = context.revisions;
            let targetEntries = context.entries;
            if (targetDate !== selectedDate) {
                const targetContext = await api(`entries?date=${encodeURIComponent(targetDate)}`);
                targetRevisions = targetContext.revisions;
                targetEntries = targetContext.entries;
            }
            if (moving) {
                const existing = targetEntries
                    .filter(entry => entry.meal === targetMeal
                        && !blocks.some(block => block.id === entry.id));
                if (existing.length) {
                    message(`目标餐次（${meals[targetMeal]}）已有 ${existing.length} 条记录，请先在该餐编辑合并，不能直接覆盖。`, true);
                    setBusy(false);
                    return;
                }
                if (!window.confirm(`把本餐移到 ${targetDate.slice(5).replace('-', '/')} 的${meals[targetMeal]}？原位置将清空。`)) {
                    setBusy(false);
                    return;
                }
            }
            const payload = {
                date: targetDate, meal: targetMeal,
                revision: targetRevisions[targetMeal],
                entries: blocks.map(block => ({
                    id: block.id, food_id: block.food_id, amount: block.amount,
                    rating: block.rating, note: block.note, mode: block.mode,
                    time: element('time').value || null
                }))
            };
            if (moving) {
                payload.from = { date: selectedDate, meal: selectedMeal, revision: context.revisions[selectedMeal] };
            }
            context = await api('meals', payload);
            selectedDate = targetDate;
            selectedMeal = targetMeal;
            dirty = false;
            if (element('history-date')) {
                element('history-date').value = selectedDate;
                await loadHistory();
            }
            setBusy(false);
            close();
            showToast(moving
                ? `已移到${targetDate.slice(5).replace('-', '/')}的${meals[targetMeal]}`
                : `已保存${meals[selectedMeal]}辅食记录`);
        } catch (error) {
            message(`保存失败：${error.message}。输入已保留。`, true);
        } finally {
            setBusy(false);
        }
    }

    async function loadHistory() {
        if (!element('history-date') || !element('history-list')) return;
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
                const mealTimes = entries.map(entry => entry.eaten_time).filter(Boolean).sort();
                card.append(node('h3', mealTimes.length ? `${label} · ${mealTimes[0]}` : label));
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
    if (element('history-date')) {
        element('history-date').value = today();
        element('history-date').max = today();
        element('history-date').addEventListener('change', loadHistory);
        loadHistory();
    }
    window.foodIntake = { open, close };
})();
