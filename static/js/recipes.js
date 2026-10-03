(() => {
    let recipes = [];
    let loaded = false;
    let busy = false;
    let editing = null;      // { id: number | null, images: string[] }
    const element = id => document.getElementById(`recipes-${id}`);

    function message(text = '', error = false) {
        element('message').textContent = text;
        element('message').dataset.error = String(error);
        element('message').hidden = !text;
    }

    async function api(path = '', method = 'GET', data) {
        const response = await fetch(`/api/food-recipes${path}`, {
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
        element('page').querySelectorAll('button, input, textarea').forEach(control => {
            control.disabled = value;
        });
    }

    function monthsLabel(months) {
        return months >= 12 ? `${months / 12}岁+` : `${months}月+`;
    }

    function showView(name) {
        element('list-view').hidden = name !== 'list';
        element('detail').hidden = name !== 'detail';
        element('editor').hidden = name !== 'editor';
        window.scrollTo(0, 0);
    }

    function renderList() {
        const container = element('list');
        container.replaceChildren();
        if (!recipes.length) {
            const empty = document.createElement('p');
            empty.className = 'recipes-hint';
            empty.textContent = loaded
                ? '没有匹配的食谱。点「📷 拍照收藏」拍下食谱图，自动整理入库。'
                : '食谱库为空。点「📷 拍照收藏」拍下小红书或食谱书上的食谱图，AI 自动整理菜名、食材和做法。';
            container.append(empty);
        }
        recipes.forEach(item => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'recipes-card';
            card.addEventListener('click', () => showDetail(item.id));
            const images = item.images || [];
            if (images.length) {
                const cover = document.createElement('div');
                cover.className = 'recipes-card-cover';
                const img = document.createElement('img');
                img.className = 'recipes-card-image';
                img.loading = 'lazy';
                img.src = `/api/food-recipes/images/${images[0]}`;
                img.alt = item.title;
                cover.append(img);
                if (images.length > 1) {
                    const more = document.createElement('span');
                    more.className = 'recipes-card-more';
                    more.textContent = `${images.length} 图`;
                    cover.append(more);
                }
                card.append(cover);
            } else {
                const ph = document.createElement('div');
                ph.className = 'recipes-card-image recipes-card-placeholder';
                ph.textContent = '🍲';
                card.append(ph);
            }
            const body = document.createElement('div');
            body.className = 'recipes-card-body';
            const title = document.createElement('strong');
            title.className = 'recipes-card-title';
            title.textContent = item.title;
            body.append(title);
            const meta = document.createElement('div');
            meta.className = 'recipes-card-meta';
            const badge = document.createElement('span');
            badge.className = 'recipes-badge';
            badge.textContent = monthsLabel(item.months_min);
            meta.append(badge);
            if (item.warnings && item.warnings.length) {
                const warn = document.createElement('span');
                warn.className = 'recipes-badge recipes-badge-warn';
                warn.textContent = `⚠️ 含过敏食材：${item.warnings.join('、')}`;
                meta.append(warn);
            }
            body.append(meta);
            const chips = document.createElement('div');
            chips.className = 'recipes-card-chips';
            (item.ingredients || []).slice(0, 6).forEach(name => {
                const chip = document.createElement('span');
                chip.className = 'recipes-chip';
                chip.textContent = name;
                chips.append(chip);
            });
            if ((item.ingredients || []).length > 6) {
                const more = document.createElement('span');
                more.className = 'recipes-chip';
                more.textContent = `+${item.ingredients.length - 6}`;
                chips.append(more);
            }
            body.append(chips);
            card.append(body);
            container.append(card);
        });
        element('count').textContent = `共 ${recipes.length} 份食谱`;
    }

    async function load() {
        setBusy(true);
        message('正在加载食谱…');
        try {
            const query = element('search').value.trim();
            const result = await api(query ? `?q=${encodeURIComponent(query)}` : '');
            recipes = result.recipes;
            loaded = true;
            renderList();
            message();
        } catch (error) {
            message(`加载失败：${error.message}。请点击“刷新”重试。`, true);
        } finally {
            setBusy(false);
            if (searchQueued) {
                searchQueued = false;
                load();
            }
        }
    }

    function showDetail(id) {
        const item = recipes.find(entry => entry.id === id);
        if (!item) return;
        const body = element('detail-body');
        body.replaceChildren();
        const images = item.images || [];
        if (images.length) {
            const gallery = document.createElement('div');
            gallery.className = images.length > 1 ? 'recipes-detail-gallery many' : 'recipes-detail-gallery';
            images.forEach(name => {
                const img = document.createElement('img');
                img.className = 'recipes-detail-image';
                img.loading = 'lazy';
                img.src = `/api/food-recipes/images/${name}`;
                img.alt = item.title;
                img.addEventListener('click', () => window.open(img.src, '_blank'));
                gallery.append(img);
            });
            body.append(gallery);
        }
        const head = document.createElement('div');
        head.className = 'recipes-detail-head';
        const title = document.createElement('h2');
        title.textContent = item.title;
        head.append(title);
        const badge = document.createElement('span');
        badge.className = 'recipes-badge';
        badge.textContent = `适领 ${monthsLabel(item.months_min)}`;
        head.append(badge);
        if (item.warnings && item.warnings.length) {
            const warn = document.createElement('span');
            warn.className = 'recipes-badge recipes-badge-warn';
            warn.textContent = `⚠️ 含过敏食材：${item.warnings.join('、')}`;
            head.append(warn);
        }
        body.append(head);
        const ingredientsTitle = document.createElement('h3');
        ingredientsTitle.textContent = '🥣 食材';
        body.append(ingredientsTitle);
        const chips = document.createElement('div');
        chips.className = 'recipes-card-chips';
        (item.ingredients || []).forEach(name => {
            const chip = document.createElement('span');
            chip.className = 'recipes-chip';
            if ((item.warnings || []).includes(name)) chip.classList.add('recipes-chip-warn');
            chip.textContent = name;
            chips.append(chip);
        });
        body.append(chips);
        if (item.steps) {
            const stepsTitle = document.createElement('h3');
            stepsTitle.textContent = '👩‍🍳 做法';
            body.append(stepsTitle);
            const steps = document.createElement('ol');
            steps.className = 'recipes-detail-steps';
            item.steps.split('\n').filter(Boolean).forEach(line => {
                const li = document.createElement('li');
                li.textContent = line;
                steps.append(li);
            });
            body.append(steps);
        }
        if (item.note) {
            const note = document.createElement('p');
            note.className = 'recipes-detail-note';
            note.textContent = `备注：${item.note}`;
            body.append(note);
        }
        const actions = document.createElement('div');
        actions.className = 'recipes-actions';
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.textContent = '编辑';
        editButton.addEventListener('click', () => openEditor(item));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.textContent = '删除';
        deleteButton.className = 'recipes-danger';
        deleteButton.addEventListener('click', () => removeRecipe(item));
        actions.append(editButton, deleteButton);
        body.append(actions);
        showView('detail');
    }

    function splitIngredients(value) {
        return value.split(/[、,，\s]+/).map(name => name.trim()).filter(Boolean);
    }

    function renderEditorImages() {
        const preview = element('editor-preview');
        preview.replaceChildren();
        if (!editing || !editing.images.length) {
            preview.hidden = true;
            return;
        }
        preview.hidden = false;
        editing.images.forEach((name, index) => {
            const cell = document.createElement('div');
            cell.className = 'recipes-editor-thumb';
            const img = document.createElement('img');
            img.src = `/api/food-recipes/images/${name}`;
            img.alt = `食谱图 ${index + 1}`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'recipes-editor-thumb-del';
            remove.textContent = '✕';
            remove.setAttribute('aria-label', '移除这张图');
            remove.addEventListener('click', () => {
                editing.images.splice(index, 1);
                renderEditorImages();
            });
            cell.append(img, remove);
            preview.append(cell);
        });
        const addCell = document.createElement('button');
        addCell.type = 'button';
        addCell.className = 'recipes-editor-thumb recipes-editor-thumb-add';
        addCell.textContent = '＋ 追加图片';
        addCell.addEventListener('click', () => {
            if (!busy) element('append-file').click();
        });
        preview.append(addCell);
    }

    function openEditor(item = null) {
        editing = item
            ? { id: item.id, images: [...(item.images || [])] }
            : { id: null, images: [] };
        element('editor-title').textContent = item ? '编辑食谱' : '收藏食谱';
        renderEditorImages();
        element('field-title').value = item?.title || '';
        element('field-months').value = item?.months_min ?? 6;
        element('field-ingredients').value = (item?.ingredients || []).join('、');
        element('field-steps').value = item?.steps || '';
        element('field-note').value = item?.note || '';
        showView('editor');
        element('field-title').focus();
    }

    async function save() {
        if (!editing || busy) return;
        const data = {
            title: element('field-title').value.trim(),
            months_min: Number(element('field-months').value) || 6,
            ingredients: splitIngredients(element('field-ingredients').value),
            steps: element('field-steps').value.trim(),
            note: element('field-note').value.trim(),
            image_names: editing.images,
        };
        if (!data.title) {
            message('菜名不能为空', true);
            return;
        }
        if (!data.ingredients.length) {
            message('请至少填写一个食材', true);
            return;
        }
        setBusy(true);
        message('正在保存…');
        try {
            if (editing.id === null) {
                await api('', 'POST', data);
            } else {
                await api(`/${editing.id}`, 'PUT', data);
            }
            toast(`已保存食谱「${data.title}」`);
            editing = null;
            showView('list');
            await load();
        } catch (error) {
            message(`保存失败：${error.message}`, true);
        } finally {
            setBusy(false);
        }
    }

    async function removeRecipe(item) {
        if (busy) return;
        if (!window.confirm(`确定删除食谱“${item.title}”吗？此操作不可撤销。`)) return;
        setBusy(true);
        try {
            await api(`/${item.id}`, 'DELETE');
            toast('已删除食谱');
            showView('list');
            await load();
        } catch (error) {
            message(`删除失败：${error.message}`, true);
        } finally {
            setBusy(false);
        }
    }

    async function uploadOcrImages(files) {
        if (!files.length || busy) return;
        for (const file of files) {
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                message('仅支持 JPG、PNG、WebP 格式的图片', true);
                return;
            }
            if (file.size > 8 * 1024 * 1024) {
                message('单张图片不能超过 8MB，请压缩后重试', true);
                return;
            }
        }
        setBusy(true);
        message(files.length > 1 ? `📷 正在识别 ${files.length} 张图片，约需几秒钟…` : '📷 正在识别食谱，约需几秒钟…');
        try {
            const form = new FormData();
            [...files].forEach(file => form.append('image', file));
            const response = await fetch('/api/food-recipes/ocr', { method: 'POST', body: form });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '识别失败，请稍后重试');
            editing = { id: null, images: result.draft.image_names || [] };
            element('editor-title').textContent = '收藏食谱（已识别）';
            renderEditorImages();
            element('field-title').value = result.draft.title;
            element('field-months').value = result.draft.months_min;
            element('field-ingredients').value = (result.draft.ingredients || []).join('、');
            element('field-steps').value = result.draft.steps || '';
            element('field-note').value = '';
            showView('editor');
            message(files.length > 1 ? `AI 已合并识别 ${files.length} 张图片，请核对后保存。` : 'AI 已识别食谱内容，请核对后保存。');
        } catch (error) {
            message(`识别失败：${error.message}`, true);
        } finally {
            setBusy(false);
        }
    }

    async function appendImages(event) {
        const files = [...event.target.files];
        event.target.value = '';
        if (!files.length || !busy) return;
        setBusy(true);
        message('正在上传图片…');
        try {
            const form = new FormData();
            files.forEach(file => form.append('image', file));
            const response = await fetch('/api/food-recipes/images', { method: 'POST', body: form });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '上传失败，请稍后重试');
            editing.images.push(...(result.image_names || []));
            renderEditorImages();
            message();
        } catch (error) {
            message(`图片上传失败：${error.message}`, true);
        } finally {
            setBusy(false);
        }
    }

    function toast(text) {
        window.showToast?.(text);
    }

    let searchTimer = null;
    let searchQueued = false;
    element('search').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            if (busy) { searchQueued = true; return; }
            load();
        }, 250);
    });
    element('refresh').addEventListener('click', () => { if (!busy) load(); });
    element('ocr').addEventListener('click', () => {
        if (!busy) element('ocr-file').click();
    });
    element('detail-back').addEventListener('click', () => showView('list'));
    element('cancel').addEventListener('click', () => {
        editing = null;
        showView('list');
        message();
    });
    element('save').addEventListener('click', save);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'recipes-ocr-file';
    fileInput.accept = 'image/jpeg,image/png,image/webp';
    fileInput.multiple = true;
    fileInput.hidden = true;
    document.body.append(fileInput);
    fileInput.addEventListener('change', event => uploadOcrImages([...event.target.files]));

    const appendInput = document.createElement('input');
    appendInput.type = 'file';
    appendInput.id = 'recipes-append-file';
    appendInput.accept = 'image/jpeg,image/png,image/webp';
    appendInput.multiple = true;
    appendInput.hidden = true;
    document.body.append(appendInput);
    appendInput.addEventListener('change', appendImages);
    load();
})();
