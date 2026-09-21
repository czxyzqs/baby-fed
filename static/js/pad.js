// API functions
async function createRecord(data) {
    try {
        const response = await fetch('/api/records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (response.ok) {
            showToast('记录已保存', '✅');
            return true;
        }
    } catch (error) {
        console.error('Failed to create record:', error);
    }
    showToast('保存失败', '❌');
    return false;
}

// Modal functions
function openModal(type) {
    const overlay = document.getElementById(`${type}-modal`);
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal(type) {
    const overlay = document.getElementById(`${type}-modal`);
    overlay.classList.remove('active');
    document.body.style.overflow = '';

    // Reset form
    const form = document.getElementById(`${type}-form`);
    if (form) form.reset();

    // Reset selection to first option
    const options = document.querySelectorAll(`#${type}-type-options .form-option`);
    options.forEach((opt, i) => opt.classList.toggle('selected', i === 0));
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

function adjustAmount(delta) {
    const input = document.getElementById('feed-amount-input');
    let val = parseInt(input.value) || 0;
    val = Math.max(0, val + delta);
    input.value = val;
}

function getLocalIsoNow() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d}T${h}:${min}:${s}+08:00`;
}

async function submitForm(type) {
    const form = document.getElementById(`${type}-form`);
    const formData = new FormData(form);

    const data = { type, time: getLocalIsoNow() };

    if (type === 'diaper') {
        data.diaperType = getSelectedValue('diaper-type');
    } else if (type === 'feed') {
        data.feedType = 'bottle';
        data.amount = formData.get('amount') || null;
        data.isNewMilk = form.querySelector('#feed-is-new-milk')?.checked || false;
    } else if (type === 'vitamin') {
        data.type = 'supplement';
        data.supplementType = getSelectedValue('vitamin-type');
    } else if (type === 'probiotic') {
        data.type = 'supplement';
        data.supplementType = 'probiotic';
    } else if (type === 'bath') {
        data.bathType = 'bath';
    }

    const note = formData.get('note');
    if (note) data.note = note;

    const success = await createRecord(data);
    if (success) {
        closeModal(type);
    }
}

function showToast(message, icon = '✅') {
    const toast = document.getElementById('toast');
    toast.querySelector('.toast-text').textContent = message;
    toast.querySelector('.toast-icon').textContent = icon;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            const type = overlay.id.replace('-modal', '');
            closeModal(type);
        }
    });
});

// Handle orientation/resize change
function refreshModalLayout() {
    document.querySelectorAll('.modal-overlay.active').forEach(overlay => {
        const modal = overlay.querySelector('.modal');
        if (modal) {
            // Force browser to recalculate styles by temporarily removing and re-adding the active class
            overlay.classList.remove('active');
            // Force reflow
            void overlay.offsetWidth;
            overlay.classList.add('active');
        }
    });
}

window.addEventListener('orientationchange', () => {
    setTimeout(refreshModalLayout, 100);
});

let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refreshModalLayout, 100);
});
