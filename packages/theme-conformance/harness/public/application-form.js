(() => {
  const form = document.querySelector('[data-application-form]');
  if (!(form instanceof HTMLFormElement)) return;
  // Keep native validation for no-JavaScript submissions while allowing the
  // enhanced form to expose the same errors through its linked summary.
  form.noValidate = true;

  const status = form.querySelector('#application-status');
  const summary = form.querySelector('[data-application-error-summary]');
  const errorList = form.querySelector('[data-application-error-list]');
  const submit = form.querySelector('button[type="submit"]');
  const resume = form.elements.namedItem('resume');
  const copy = (() => { try { return JSON.parse(form.dataset.applicationCopy || '{}'); } catch { return {}; } })();
  const fieldNames = { name: 'Full name', email: 'Email', telephone: 'Phone', linkedIn: copy.linkedInLabel || 'LinkedIn', coverLetter: copy.noteLabel || 'Note', resume: 'Resume', consent: 'Consent' };
  const upload = form.querySelector('[data-application-upload]'); const filename = form.querySelector('[data-application-upload-filename]'); const uploadLabel = form.querySelector('[data-application-upload-label]'); const uploadPrompt = uploadLabel?.textContent || 'Choose a file or drop it here';
  let pending = false; let accepted = false; let retryFingerprint = ''; let retryKey = ''; const maxResumeBytes = 5_000_000; const emailFormat = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const field = (name) => form.elements.namedItem(name);
  const fieldError = (name) => form.querySelector(`[data-application-field-error="${name}"]`);
  const clearErrors = () => {
    for (const name of Object.keys(fieldNames)) {
      const control = field(name); const message = fieldError(name);
      if (control instanceof HTMLElement) control.removeAttribute('aria-invalid');
      if (message) { message.hidden = true; message.textContent = ''; }
    }
    if (summary) summary.hidden = true;
    if (errorList) errorList.replaceChildren();
  };
  const showErrors = (errors, focus = true) => {
    clearErrors();
    if (!errors.length || !summary || !errorList) return;
    for (const { name, message } of errors) {
      const control = field(name); const detail = fieldError(name);
      if (control instanceof HTMLElement) control.setAttribute('aria-invalid', 'true');
      if (detail) { detail.hidden = false; detail.textContent = message; }
      const item = document.createElement('li');
      if (control instanceof HTMLElement) {
        const link = document.createElement('a');
        link.href = `#application-${name === 'linkedIn' ? 'linkedin' : name === 'coverLetter' ? 'cover-letter' : name}`;
        link.textContent = `${fieldNames[name] || 'Application'}: ${message}`;
        link.addEventListener('click', (event) => { event.preventDefault(); control.focus(); });
        item.append(link);
      } else item.textContent = message;
      errorList.append(item);
    }
    summary.hidden = false;
    if (focus) summary.focus();
  };
  const setFormError = (message) => showErrors([{ name: 'form', message }]);
  const setFilename = () => { const name = resume instanceof HTMLInputElement && resume.files?.[0] ? resume.files[0].name : ''; if (filename) filename.textContent = name; if (uploadLabel) uploadLabel.textContent = name || uploadPrompt; };
  const setBusy = (busy) => {
    for (const element of form.elements) if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement) element.disabled = busy || accepted;
    if (submit instanceof HTMLButtonElement) submit.textContent = busy ? 'Submitting application…' : (copy.submitLabel || 'Submit application');
    form.dataset.applicationState = busy ? 'pending' : accepted ? 'success' : 'idle';
  };
  const validResume = () => {
    if (!(resume instanceof HTMLInputElement) || !resume.files?.[0]) { if (resume instanceof HTMLInputElement) resume.setCustomValidity(''); return ''; }
    const file = resume.files[0]; const extension = file.name.toLowerCase().split('.').pop();
    const message = file.size > maxResumeBytes ? 'Choose a resume smaller than 5 MB.' : extension !== 'pdf' && extension !== 'docx' ? 'Choose a PDF or DOCX resume.' : '';
    resume.setCustomValidity(message); return message;
  };
  const validationErrors = () => {
    const resumeMessage = validResume(); const errors = [];
    const nameField = field('name'); if (nameField instanceof HTMLInputElement && !nameField.value.trim()) { errors.push({ name: 'name', message: copy.nameRequired || 'Enter full name.' }); }
    const emailField = field('email'); if (emailField instanceof HTMLInputElement && emailField.value && !emailFormat.test(emailField.value)) { errors.push({ name: 'email', message: copy.emailInvalid || 'Enter a valid email address.' }); }
    for (const [name, label] of Object.entries(fieldNames)) {
      const control = field(name);
      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) || control.validity.valid || (name === 'name' && !control.value.trim()) || (name === 'email' && control.value && !emailFormat.test(control.value))) continue;
      const message = name === 'resume' && resumeMessage ? resumeMessage : name === 'name' && control.validity.valueMissing ? (copy.nameRequired || control.validationMessage) : name === 'email' && control.validity.valueMissing ? (copy.emailRequired || control.validationMessage) : name === 'email' && control.validity.typeMismatch ? (copy.emailInvalid || control.validationMessage) : name === 'resume' && control.validity.valueMissing ? (copy.resumeRequired || control.validationMessage) : name === 'consent' && control.validity.valueMissing ? (copy.consentRequired || control.validationMessage) : control.validity.valueMissing ? `Enter ${label.toLowerCase()}.` : control.validationMessage;
      errors.push({ name, message });
    }
    return errors;
  };
  const fingerprint = async (data) => {
    const values = [];
    for (const [name, value] of data.entries()) {
      if (name === 'idempotencyKey') continue;
      if (value instanceof File) {
        const bytes = new Uint8Array(await value.arrayBuffer()); const digest = await crypto.subtle.digest('SHA-256', bytes);
        values.push([name, value.name, value.type, value.size, Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')]);
      } else values.push([name, value]);
    }
    return JSON.stringify(values);
  };

  resume?.addEventListener('change', () => { setFilename(); const message = validResume(); if (message) showErrors([{ name: 'resume', message }], false); else clearErrors(); });
  if (upload && resume instanceof HTMLInputElement) { upload.addEventListener('dragover', event => { if (!resume.disabled) { event.preventDefault(); upload.dataset.dragging = 'true'; } }); upload.addEventListener('dragleave', () => { delete upload.dataset.dragging; }); upload.addEventListener('drop', event => { event.preventDefault(); delete upload.dataset.dragging; if (resume.disabled || pending || accepted || !event.dataTransfer?.files?.length) return; if (event.dataTransfer.files.length !== 1) { showErrors([{ name: 'resume', message: 'Choose one resume file.' }], false); return; } resume.files = event.dataTransfer.files; resume.dispatchEvent(new Event('change', { bubbles: true })); }); }
  form.addEventListener('input', () => { if (summary && !summary.hidden) clearErrors(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (accepted || pending) return;
    const errors = validationErrors();
    if (errors.length) { showErrors(errors); return; }
    clearErrors(); pending = true;
    const data = new FormData(form); setBusy(true); let currentFingerprint; try { currentFingerprint = await fingerprint(data); } catch { pending = false; setBusy(false); setFormError('We could not prepare your application. Try again.'); return; }
    if (currentFingerprint !== retryFingerprint) { retryFingerprint = currentFingerprint; retryKey = crypto.randomUUID(); }
    data.set('idempotencyKey', retryKey);
    if (status) status.textContent = 'Submitting your application.';
    try {
      const response = await fetch('/api/applications', { method: 'POST', body: data, credentials: 'same-origin' }); const body = await response.json().catch(() => undefined);
      if (!response.ok || !body?.id) throw new Error('rejected');
      accepted = true; pending = false; window.dispatchEvent(new CustomEvent('site-conversion', { detail: { form: 'application', accepted: true } })); setBusy(false);
      if (status) status.textContent = (copy.successMessage || 'Your application has been received.');
    } catch {
      pending = false; window.dispatchEvent(new CustomEvent('site-conversion', { detail: { form: 'application', accepted: false } })); setBusy(false);
      if (status) status.textContent = ''; setFormError('We could not submit your application. Check your connection and try again.');
    }
  });
})();
