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

    function render(items) {
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
            // 计划中的新食物首次记录用 start（开启排敏轮次），已排敏中的用 keep
            entries.push({
                food_id: item.food_id, amount: state.amount, rating: state.rating,
                note: '', mode: item.kind === 'planned' ? 'start' : 'keep'
            });
            await api('meals', 'POST', {
                date: dateValue, meal: state.meal,
                revision: result.revisions[state.meal],
                entries
            });
            closeDialog();
            document.body.style.overflow = '';
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
            document.body.style.overflow = '';
            toast(`已记录「${item.food}」的反应`);
        } catch (error) {
            toast(`保存失败：${error.message}`);
        }
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay) closeDialog();
    });

    window.addEventListener('pageshow', event => { if (event.persisted) load(); });
    load();
})();
