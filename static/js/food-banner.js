/* 首页排敏横幅：计划行、待标记提醒；点计划行弹出「记录进食/记录反应」弹窗 */
(() => {
    const banner = document.getElementById('food-screening-banner');
    const body = document.getElementById('food-screening-banner-body');
    if (!banner || !body) return;

    const AMOUNTS = ['一勺尖', '一勺', '两勺', '三勺', '半碗', '一碗'];
    const RATINGS = [['喜欢', '😋 喜欢'], ['一般', '😐 一般'], ['拒绝', '🥴 拒绝']];
    const SYMPTOMS = ['口周红疹', '荨麻疹', '呕吐', '腹泻', '便秘', '湿疹加重', '其他'];
    const MEALS = { breakfast: '早餐', lunch: '午餐', snack: '下午茶', dinner: '晚餐' };

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    function chip(text, handler, active = false) {
        const result = node('button', text, 'banner-chip' + (active ? ' active' : ''));
        result.type = 'button';
        result.addEventListener('click', handler);
        return result;
    }

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

    async function api(path, method = 'GET', data) {
        const response = await fetch(`/api/${path}`, {
            method, cache: 'no-store',
            headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试');
        return result;
    }

    function toast(text) {
        window.showToast?.(text);
    }

    async function load() {
        try {
            const response = await fetch('/api/screening/banner', { cache: 'no-store' });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '加载失败');
            render(result.items || []);
        } catch (error) {
            banner.hidden = true;
        }
    }

    let lastItems = [];
    let todayContext = null;

    async function getContext() {
        if (!todayContext) todayContext = await api(`entries?date=${today()}`);
        return todayContext;
    }

    function render(items) {
        lastItems = items;
        body.replaceChildren();
        if (!items.length) {
            banner.hidden = true;
            return;
        }
        banner.hidden = false;
        items.forEach(item => {
            const card = node('div', '', 'food-banner-item' + (item.kind === 'due' ? ' food-banner-due' : ''));
            if (item.kind === 'due') {
                card.append(node('span', `🔔 ${item.food} ${item.text}`, 'food-banner-text'));
                const jump = node('a', '去标记 ›', 'food-banner-link');
                jump.href = '/screening';
                card.append(jump);
            } else {
                card.append(node('span', `${item.food}${item.text ? `（${item.text}）` : ''}`, 'food-banner-text'));
                card.addEventListener('click', () => openFoodDialog(item));
                card.style.cursor = 'pointer';
            }
            body.append(card);
        });
    }

    // ---------- 记录弹窗：进食 + 反应 ----------

    let overlay = null;

    function closeDialog() {
        overlay?.remove();
        overlay = null;
        document.body.style.overflow = '';
    }

    // ---------- 快速添加：有规划直接进记录界面（预选规划食物），否则选食物 ----------

    const STATUS_LABELS = { untouched: '未排敏', screening: '排敏中', normal: '正常', allergic: '过敏' };

    async function openQuickAdd() {
        let context;
        try {
            context = await getContext();
        } catch (error) {
            toast(`加载食物失败：${error.message}`);
            return;
        }
        const preferred = lastItems.find(item => item.kind !== 'due');
        if (preferred) {
            openFoodDialog(preferred);
            return;
        }
        openPickerDialog(context);
    }

    function openPickerDialog(context) {
        closeDialog();
        overlay = node('div', '', 'banner-dialog-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeDialog();
        });
        const dialog = node('div', '', 'banner-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const head = node('div', '', 'banner-dialog-head');
        head.append(node('h2', '选择食物', 'banner-dialog-title'));
        const close = node('button', '✕', 'banner-dialog-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', closeDialog);
        head.append(close);
        dialog.append(head);

        const search = node('input', '', 'banner-search');
        search.type = 'search';
        search.placeholder = '搜索食物';
        search.addEventListener('input', () => renderPickerList(list, search, context));
        dialog.append(search);
        const list = node('div', '', 'banner-picker-list');
        dialog.append(list);
        renderPickerList(list, search, context);

        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';
        search.focus();
    }

    function renderPickerList(list, search, context) {
        const query = (search.value || '').trim().toLocaleLowerCase();
        list.replaceChildren();
        context.categories.forEach(category => {
            const foods = context.foods.filter(food =>
                food.category_id === category.id &&
                (!query || food.name.toLocaleLowerCase().includes(query)));
            if (!foods.length) return;
            const title = node('h3',
                `${category.emoji} ${category.name}${category.is_high_allergen ? ' ⚠️' : ''}`,
                'banner-dialog-section');
            list.append(title);
            const group = node('div', '', 'banner-chip-group');
            foods.forEach(food => {
                const eaten = context.entries.some(entry => entry.food_id === food.id);
                group.append(chip(
                    `${food.name} · ${STATUS_LABELS[food.status]}${eaten ? ' · 今天已吃' : ''}`,
                    () => openFoodDialogForFood(food)
                ));
            });
            list.append(group);
        });
        if (!list.children.length) list.append(node('p', '没有匹配的食物，可到辅食库添加。', 'banner-dialog-section'));
    }

    function openFoodDialogForFood(food) {
        const kindMap = { untouched: 'planned', screening: 'screening', normal: 'normal', allergic: 'allergic' };
        const item = {
            food_id: food.id,
            food: food.name,
            kind: kindMap[food.status] || 'normal',
            position: food.position || 1
        };
        item.text = food.status === 'screening'
            ? `第${food.position}/${food.observe_days}天`
            : STATUS_LABELS[food.status];
        openFoodDialog(item);
    }

    function openFoodDialog(item) {
        closeDialog();
        const state = {
            amount: AMOUNTS[Math.min(Math.max(item.position || 1, 1), 4) - 1],
            rating: null,
            symptoms: new Set(),
            meal: suggestedMeal()
        };
        overlay = node('div', '', 'banner-dialog-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeDialog();
        });
        const dialog = node('div', '', 'banner-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const head = node('div', '', 'banner-dialog-head');
        const title = node('h2', `${item.food} · ${item.text || '今日计划'}`, 'banner-dialog-title');
        const close = node('button', '✕', 'banner-dialog-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', closeDialog);
        head.append(title, close);
        dialog.append(head);

        // 换食物：回到选择器
        const switchRow = node('div', '', 'banner-switch-row');
        const switchBtn = node('button', '⟳ 换个食物', 'banner-switch');
        switchBtn.type = 'button';
        switchBtn.addEventListener('click', async () => {
            try {
                openPickerDialog(await getContext());
            } catch (error) {
                toast(`加载食物失败：${error.message}`);
            }
        });
        switchRow.append(switchBtn);
        dialog.append(switchRow);

        // 过敏食物需确认记录方式（服务端状态机要求）
        if (item.kind === 'allergic') {
            state.modeOverride = 'retry';
            dialog.append(node('h3', `⚠️ ${item.food} 已标记过敏，这次怎么记？`, 'banner-dialog-section'));
            const modeGroup = node('div', '', 'banner-chip-group');
            [['retry', '按新一轮排敏'], ['only', '仅记录（误食等）']].forEach(([value, label], index) => {
                const option = chip(label, () => {
                    state.modeOverride = value;
                    [...modeGroup.children].forEach(child => child.classList.remove('active'));
                    option.classList.add('active');
                }, index === 0);
                modeGroup.append(option);
            });
            dialog.append(modeGroup);
        }

        // 记录进食
        dialog.append(node('h3', '今天吃了吗？', 'banner-dialog-section'));
        const amountGroup = node('div', '', 'banner-chip-group');
        AMOUNTS.forEach(value => {
            const option = chip(value, () => {
                state.amount = value;
                [...amountGroup.children].forEach(child => child.classList.remove('active'));
                option.classList.add('active');
            }, value === state.amount);
            if (value === state.amount) option.classList.add('suggested');
            amountGroup.append(option);
        });
        dialog.append(amountGroup);
        const ratingGroup = node('div', '', 'banner-chip-group');
        RATINGS.forEach(([value, label]) => {
            ratingGroup.append(chip(label, () => {
                state.rating = state.rating === value ? null : value;
                [...ratingGroup.children].forEach(child => child.classList.remove('active'));
                if (state.rating) [...ratingGroup.children][RATINGS.findIndex(entry => entry[0] === state.rating)].classList.add('active');
            }));
        });
        dialog.append(ratingGroup);
        const eatButton = node('button', '保存今日进食', 'banner-dialog-primary');
        eatButton.type = 'button';
        eatButton.addEventListener('click', () => saveIntake(item, state));
        dialog.append(eatButton);

        // 记录反应
        dialog.append(node('h3', '出现过敏反应时记录（无反应不用记）', 'banner-dialog-section'));
        const symptomGroup = node('div', '', 'banner-chip-group');
        SYMPTOMS.forEach(value => {
            symptomGroup.append(chip(value, event => {
                if (state.symptoms.has(value)) {
                    state.symptoms.delete(value);
                    event.currentTarget.classList.remove('active');
                } else {
                    state.symptoms.add(value);
                    event.currentTarget.classList.add('active');
                }
            }));
        });
        dialog.append(symptomGroup);
        const reactButton = node('button', '记录反应', 'banner-dialog-danger');
        reactButton.type = 'button';
        reactButton.addEventListener('click', () => saveReaction(item, state));
        dialog.append(reactButton);

        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';
        if (item.eaten_today) prefillIntake(item, state, amountGroup, ratingGroup, eatButton);
    }

    async function prefillIntake(item, state, amountGroup, ratingGroup, eatButton) {
        try {
            const result = await api(`entries?date=${today()}`);
            const entry = result.entries.find(row => row.food_id === item.food_id);
            if (!entry || !overlay) return;
            state.amount = entry.amount;
            state.rating = entry.rating || null;
            state.meal = entry.meal;
            [...amountGroup.children].forEach(child => {
                child.classList.toggle('active', child.textContent === entry.amount);
                child.classList.remove('suggested');
            });
            if (state.rating) {
                const index = RATINGS.findIndex(row => row[0] === state.rating);
                [...ratingGroup.children].forEach((child, position) => child.classList.toggle('active', position === index));
            }
            eatButton.textContent = `更新今日进食（${MEALS[state.meal]}已记录）`;
        } catch (error) {
            // 预填失败不影响手动记录
        }
    }

    async function saveIntake(item, state) {
        try {
            const dateValue = today();
            const result = await api(`entries?date=${dateValue}`);
            const others = result.entries.filter(row => row.meal === state.meal && row.food_id !== item.food_id);
            const entries = others.map(row => ({
                id: row.id, food_id: row.food_id, amount: row.amount,
                rating: row.rating, note: row.note, mode: 'keep'
            }));
            // 新食物首次记录用 start（开启排敏轮次），过敏食物用确认的记录方式，其余 keep
            entries.push({
                food_id: item.food_id, amount: state.amount, rating: state.rating,
                note: '', mode: state.modeOverride || (item.kind === 'planned' ? 'start' : 'keep')
            });
            await api('meals', 'POST', {
                date: dateValue, meal: state.meal,
                revision: result.revisions[state.meal],
                entries
            });
            todayContext = null;
            closeDialog();
            toast(`已记录${MEALS[state.meal]}：${item.food} ${state.amount}`);
            load();
        } catch (error) {
            toast(`保存失败：${error.message}`);
        }
    }

    async function saveReaction(item, state) {
        if (!state.symptoms.size) {
            toast('请先选择症状；无反应不用记录');
            return;
        }
        try {
            await api('screening/reactions', 'POST', {
                food_id: item.food_id, date: today(),
                symptoms: [...state.symptoms], note: ''
            });
            closeDialog();
            toast(`已记录「${item.food}」的反应`);
        } catch (error) {
            toast(`保存失败：${error.message}`);
        }
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay) closeDialog();
    });

    window.foodQuickRecord = { open: openQuickAdd };
    window.addEventListener('pageshow', event => { if (event.persisted) load(); });
    load();
})();
