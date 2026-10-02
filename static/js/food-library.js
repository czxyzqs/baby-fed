(() => {
    let library = { categories: [], foods: [] };
    let loaded = false;
    let busy = false;
    let editor = null;
    let ocrState = null;
    let requestVersion = 0;
    let activeCategory = '';
    const element = id => document.getElementById(`food-library-${id}`);

    function message(text = '', error = false) {
        element('message').textContent = text;
        element('message').dataset.error = String(error);
        element('message').hidden = !text;
    }

    async function api(path = '', method = 'GET', data) {
        const response = await fetch(`/api/food-library${path}`, {
            method,
            cache: 'no-store',
            headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试');
        return result;
    }

    function setBusy(value) {
        busy = value;
        element('page').setAttribute('aria-busy', String(value));
        element('page').querySelectorAll('button, input, select').forEach(control => {
            control.disabled = value;
        });
        if (!value) {
            element('add-food').disabled = !loaded || !library.categories.length;
            element('add-category').disabled = !loaded || library.categories.length >= 20;
        }
    }

    function fillCategories(select, selected, all = false) {
        select.replaceChildren();
        if (all) select.add(new Option('全部品类', ''));
        library.categories.forEach(category => {
            select.add(new Option(`${category.emoji} ${category.name}`, String(category.id)));
        });
        if ([...select.options].some(option => option.value === String(selected))) {
            select.value = String(selected);
        }
    }

    function action(label, handler, className = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.className = className;
        button.addEventListener('click', handler);
        return button;
    }

    // 食物名模糊匹配：包含子串，或输入字符按顺序出现（允许间隔），如「三鱼」匹配「三文鱼」
    function fuzzyMatch(name, query) {
        const lower = name.toLocaleLowerCase();
        if (lower.includes(query)) return true;
        let index = 0;
        for (const character of query) {
            index = lower.indexOf(character, index);
            if (index === -1) return false;
            index += 1;
        }
        return true;
    }

    function renderTabs() {
        if (activeCategory && !library.categories.some(category => String(category.id) === activeCategory)) {
            activeCategory = '';
        }
        const nav = element('tabs');
        nav.replaceChildren();
        const tabs = [['', `全部 · ${library.foods.length} 种`]].concat(library.categories.map(
            category => [String(category.id), `${category.emoji} ${category.name}${category.is_high_allergen ? ' ⚠️' : ''}`]
        ));
        tabs.forEach(([value, label]) => {
            const tab = action(label, () => {
                if (busy) return;
                activeCategory = value;
                render();
            }, 'food-library-tab');
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(activeCategory === value));
            if (activeCategory === value) tab.classList.add('active');
            nav.append(tab);
        });
    }

    function render() {
        renderTabs();
        const query = element('search').value.trim().toLocaleLowerCase();
        const selected = activeCategory;
        const list = element('list');
        list.replaceChildren();
        let visibleCount = 0;
        library.categories.forEach(category => {
            if (selected && String(category.id) !== selected) return;
            const foods = library.foods.filter(food => food.category_id === category.id);
            const matches = query ? foods.filter(food => fuzzyMatch(food.name, query)) : foods;
            if (query && !matches.length) return;
            visibleCount += matches.length;
            const group = document.createElement('section');
            group.className = 'food-library-group';
            const header = document.createElement('div');
            header.className = 'food-library-group-header';
            const title = document.createElement('h3');
            title.textContent = `${category.emoji} ${category.name} · ${foods.length} 种`;
            header.append(title);
            if (category.is_high_allergen) {
                const warning = document.createElement('p');
                warning.textContent = '⚠️ 高致敏品类';
                header.append(warning);
            }
            const controls = document.createElement('div');
            controls.className = 'food-library-actions';
            controls.append(
                action('＋ 食物', () => openEditor('food', null, category.id)),
                action('编辑品类', () => openEditor('category', category)),
                action('删除品类', () => removeItem('category', category), 'food-library-danger')
            );
            header.append(controls);
            group.append(header);
            matches.forEach(food => {
                const row = document.createElement('div');
                row.className = 'food-library-row';
                const name = document.createElement('strong');
                name.textContent = food.name;
                const buttons = document.createElement('div');
                buttons.className = 'food-library-actions';
                buttons.append(
                    action('编辑', () => openEditor('food', food)),
                    action('删除', () => removeItem('food', food), 'food-library-danger')
                );
                row.append(name, buttons);
                group.append(row);
            });
            if (!foods.length) {
                const empty = document.createElement('p');
                empty.className = 'food-library-hint';
                empty.textContent = '这个品类还没有食物，点击“＋ 食物”添加。';
                group.append(empty);
            }
            list.append(group);
        });
        element('count').textContent = `共 ${library.categories.length}/20 个品类 · ${library.foods.length} 种食物 · 当前显示 ${visibleCount} 种`;
        if (!list.children.length) {
            const empty = document.createElement('p');
            empty.className = 'food-library-hint';
            empty.textContent = library.categories.length ? '没有匹配的食物，请更换搜索词。' : '食物池为空，请先新增品类，再添加食物。';
            list.append(empty);
        }
    }

    async function load() {
        const version = ++requestVersion;
        setBusy(true);
        message('正在加载食物池…');
        try {
            const result = await api();
            if (version !== requestVersion) return;
            library = result;
            loaded = true;
            render();
            message();
        } catch (error) {
            if (version === requestVersion) message(`加载失败：${error.message}。请点击“刷新”重试。`, true);
        } finally {
            if (version === requestVersion) setBusy(false);
        }
    }

    function showPool() {
        editor = null;
        ocrState = null;
        element('editor').hidden = true;
        element('ocr-panel').hidden = true;
        element('pool').hidden = false;
        window.scrollTo(0, 0);
    }

    function openEditor(kind, item = null, categoryId = null) {
        if (busy || !loaded) return;
        editor = { kind, id: item?.id ?? null };
        message();
        element('editor').reset();
        element('pool').hidden = true;
        element('editor').hidden = false;
        element('editor-title').textContent = `${item ? '编辑' : '新增'}${kind === 'food' ? '食物' : '品类'}`;
        element('name').maxLength = kind === 'food' ? 50 : 30;
        element('name').value = item?.name || '';
        element('food-fields').hidden = kind !== 'food';
        element('category-fields').hidden = kind !== 'category';
        element('category').required = kind === 'food';
        element('emoji').required = kind === 'category';
        fillCategories(element('category'), item?.category_id ?? categoryId ?? (Number(activeCategory) || undefined));
        element('emoji').value = item?.emoji || '🥣';
        element('allergen').checked = item?.is_high_allergen === true;
        window.scrollTo(0, 0);
        element('name').focus();
    }

    async function mutate(path, method, data, success, afterSuccess) {
        if (busy) return;
        setBusy(true);
        message('正在保存…');
        let saved = false;
        try {
            await api(path, method, data);
            saved = true;
            afterSuccess?.();
            library = await api();
            loaded = true;
            render();
            message();
            window.showToast?.(success);
        } catch (error) {
            message(saved ? `${success}，但列表刷新失败，请点击“刷新”重试。` : error.message, true);
        } finally {
            setBusy(false);
        }
    }

    async function save(event) {
        event.preventDefault();
        if (!editor || busy) return;
        const { kind, id } = editor;
        const data = { name: element('name').value.trim() };
        if (!data.name) {
            message('名称不能为空', true);
            return;
        }
        if (kind === 'food') {
            data.category_id = Number(element('category').value);
        } else {
            data.emoji = element('emoji').value.trim();
            data.is_high_allergen = element('allergen').checked;
        }
        const collection = kind === 'food' ? 'foods' : 'categories';
        await mutate(`/${collection}${id === null ? '' : `/${id}`}`, id === null ? 'POST' : 'PUT', data,
            `已保存${kind === 'food' ? '食物' : '品类'}「${data.name}」`, () => {
            element('search').value = '';
            if (kind === 'food') activeCategory = String(data.category_id);
            showPool();
        });
    }

    async function removeItem(kind, item) {
        if (busy) return;
        if (kind === 'category' && library.foods.some(food => food.category_id === item.id)) {
            message('该品类还有食物，请先编辑食物转移到其他品类，或删除其中的食物。', true);
            element('message').scrollIntoView({ block: 'nearest' });
            return;
        }
        const label = kind === 'food' ? '食物' : '品类';
        if (!window.confirm(`确定删除${label}“${item.name}”吗？此操作不可撤销。`)) return;
        await mutate(`/${kind === 'food' ? 'foods' : 'categories'}/${item.id}`, 'DELETE', undefined, `已删除${label}`);
    }

    // ---------- 拍照导入：OCR 识别 + 确认入库 ----------

    async function uploadOcrImage(event) {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file || busy) return;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            message('仅支持 JPG、PNG、WebP 格式的图片', true);
            return;
        }
        if (file.size > 8 * 1024 * 1024) {
            message('图片不能超过 8MB，请压缩后重试', true);
            return;
        }
        setBusy(true);
        message('📷 正在识别图片，约需几秒钟…');
        try {
            const form = new FormData();
            form.append('image', file);
            const response = await fetch('/api/food-library/ocr/import', { method: 'POST', body: form });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '识别失败，请稍后重试');
            if (!result.groups.length) {
                message('没有从图片中识别出可添加的食物，请换一张更清晰的清单图片。', true);
                return;
            }
            showOcrPanel(result);
            message();
        } catch (error) {
            message(`识别失败：${error.message}`, true);
        } finally {
            setBusy(false);
        }
    }

    function showOcrPanel(result) {
        ocrState = result.groups.map(group => ({
            categoryId: group.existing_category_id === null ? 'new' : String(group.existing_category_id),
            newName: group.category_name,
            newEmoji: group.emoji || '🥣',
            newAllergen: group.is_high_allergen === true,
            foods: (group.foods || []).map(food => ({
                name: food.name, exists: food.exists === true, checked: !food.exists
            }))
        }));
        element('ocr-lines').textContent = `识别文字：${result.lines.join(' / ')}`;
        element('pool').hidden = true;
        element('editor').hidden = true;
        element('ocr-panel').hidden = false;
        renderOcrGroups();
        window.scrollTo(0, 0);
    }

    function renderOcrGroups() {
        const container = element('ocr-groups');
        container.replaceChildren();
        ocrState.forEach((group, groupIndex) => {
            const card = document.createElement('div');
            card.className = 'food-library-ocr-group';
            const head = document.createElement('div');
            head.className = 'food-library-ocr-head';
            const categorySelect = document.createElement('select');
            categorySelect.className = 'form-input';
            library.categories.forEach(category => {
                categorySelect.add(new Option(`${category.emoji} ${category.name}`, String(category.id)));
            });
            if (library.categories.length < 20) categorySelect.add(new Option('➕ 新建品类…', 'new'));
            if ([...categorySelect.options].some(option => option.value === group.categoryId)) {
                categorySelect.value = group.categoryId;
            }
            categorySelect.addEventListener('change', () => {
                group.categoryId = categorySelect.value;
                renderOcrGroups();
            });
            head.append(categorySelect);
            const toggle = action(group.foods.every(food => food.checked) ? '全不选' : '全选', () => {
                const target = !group.foods.every(food => food.checked);
                group.foods.forEach(food => { food.checked = target; });
                renderOcrGroups();
            });
            head.append(toggle);
            card.append(head);
            if (group.categoryId === 'new') {
                const creator = document.createElement('div');
                creator.className = 'food-library-ocr-new';
                const nameInput = document.createElement('input');
                nameInput.className = 'form-input';
                nameInput.placeholder = '新品类名称';
                nameInput.maxLength = 30;
                nameInput.value = group.newName;
                nameInput.addEventListener('input', () => { group.newName = nameInput.value; });
                const emojiInput = document.createElement('input');
                emojiInput.className = 'form-input';
                emojiInput.placeholder = '图标';
                emojiInput.maxLength = 16;
                emojiInput.value = group.newEmoji;
                emojiInput.addEventListener('input', () => { group.newEmoji = emojiInput.value; });
                const allergenLabel = document.createElement('label');
                allergenLabel.className = 'food-library-checkbox';
                const allergenInput = document.createElement('input');
                allergenInput.type = 'checkbox';
                allergenInput.checked = group.newAllergen;
                allergenInput.addEventListener('change', () => { group.newAllergen = allergenInput.checked; });
                allergenLabel.append(allergenInput, document.createTextNode(' 高致敏品类'));
                creator.append(nameInput, emojiInput, allergenLabel);
                card.append(creator);
            }
            const list = document.createElement('div');
            list.className = 'food-library-ocr-foods';
            group.foods.forEach((food, foodIndex) => {
                const row = document.createElement('label');
                row.className = 'food-library-ocr-food';
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.checked = food.checked;
                check.addEventListener('change', () => { food.checked = check.checked; });
                const nameInput = document.createElement('input');
                nameInput.className = 'form-input';
                nameInput.value = food.name;
                nameInput.maxLength = 50;
                nameInput.addEventListener('input', () => { food.name = nameInput.value; });
                row.append(check, nameInput);
                if (food.exists) {
                    const badge = document.createElement('span');
                    badge.className = 'food-library-ocr-badge';
                    badge.textContent = '已有';
                    row.append(badge);
                }
                list.append(row);
            });
            card.append(list);
            container.append(card);
        });
    }

    async function confirmOcrImport() {
        if (busy || !ocrState) return;
        const picked = ocrState.map(group => ({
            ...group,
            foods: group.foods.filter(food => food.checked && food.name.trim())
        })).filter(group => group.foods.length);
        if (!picked.length) {
            message('请先勾选要导入的食物', true);
            return;
        }
        if (picked.some(group => group.categoryId === 'new' && !group.newName.trim())) {
            message('请填写新建品类的名称', true);
            return;
        }
        setBusy(true);
        message('正在导入…');
        let createdCategories = 0;
        let createdFoods = 0;
        const skipped = [];
        const failed = [];
        try {
            for (const group of picked) {
                let categoryId = Number(group.categoryId);
                if (group.categoryId === 'new') {
                    try {
                        const result = await api('/categories', 'POST', {
                            name: group.newName.trim(),
                            emoji: group.newEmoji.trim() || '🥣',
                            is_high_allergen: group.newAllergen
                        });
                        categoryId = result.id ?? result;
                        createdCategories += 1;
                    } catch (error) {
                        group.foods.forEach(food => failed.push(`${food.name}（品类创建失败：${error.message}）`));
                        continue;
                    }
                }
                for (const food of group.foods) {
                    try {
                        await api('/foods', 'POST', { name: food.name.trim(), category_id: categoryId });
                        createdFoods += 1;
                    } catch (error) {
                        if (error.message.includes('同名')) skipped.push(food.name);
                        else failed.push(`${food.name}：${error.message}`);
                    }
                }
            }
            const parts = [`已导入 ${createdFoods} 个食物`];
            if (createdCategories) parts.push(`${createdCategories} 个新品类`);
            if (skipped.length) parts.push(`${skipped.length} 个已存在跳过`);
            if (failed.length) parts.push(`${failed.length} 个失败`);
            window.showToast?.(parts.join('，'));
            if (failed.length) {
                message(`部分导入失败：${failed.join('；')}`, true);
            } else {
                message();
            }
            showPool();
            await load();
        } finally {
            setBusy(false);
        }
    }

    element('search').addEventListener('input', render);
    element('refresh').addEventListener('click', load);
    element('add-food').addEventListener('click', () => openEditor('food'));
    element('add-category').addEventListener('click', () => openEditor('category'));
    element('ocr').addEventListener('click', () => {
        if (!busy) element('ocr-file').click();
    });
    element('ocr-file').addEventListener('change', uploadOcrImage);
    element('ocr-confirm').addEventListener('click', confirmOcrImport);
    element('ocr-cancel').addEventListener('click', () => {
        showPool();
        message();
    });
    element('cancel').addEventListener('click', () => {
        showPool();
        message();
    });
    element('editor').addEventListener('submit', save);
    window.addEventListener('pageshow', event => {
        if (event.persisted && !busy && !editor) load();
    });
    load();
})();
