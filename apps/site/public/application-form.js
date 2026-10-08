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
  const fieldNames = { name: 'Full name', email: 'Email', telephone: 'Phone', linkedIn: 'LinkedIn', coverLetter: 'Note', resume: 'Resume', consent: 'Consent' };
  let accepted = false; let retryFingerprint = ''; let retryKey = ''; const maxResumeBytes = 5_000_000;

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
      const item = document.createElement('li'); const link = document.createElement('a');
      link.href = `#application-${name === 'linkedIn' ? 'linkedin' : name === 'coverLetter' ? 'cover-letter' : name}`;
      link.textContent = `${fieldNames[name] || 'Application'}: ${message}`;
      link.addEventListener('click', (event) => { event.preventDefault(); if (control instanceof HTMLElement) control.focus(); });
      item.append(link); errorList.append(item);
    }
    summary.hidden = false;
    if (focus) requestAnimationFrame(() => summary.focus());
  };
  const setFormError = (message) => showErrors([{ name: 'form', message }]);
  const setBusy = (busy) => {
    for (const element of form.elements) if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement) element.disabled = busy || accepted;
    if (submit instanceof HTMLButtonElement) submit.textContent = busy ? 'Submitting application…' : 'Submit application';
    form.dataset.applicationState = busy ? 'pending' : accepted ? 'success' : 'idle';
  };
  const validResume = () => {
    if (!(resume instanceof HTMLInputElement) || !resume.files?.[0]) return '';
    const file = resume.files[0]; const extension = file.name.toLowerCase().split('.').pop();
    const message = file.size > maxResumeBytes ? 'Choose a resume smaller than 5 MB.' : extension !== 'pdf' && extension !== 'docx' ? 'Choose a PDF or DOCX resume.' : '';
    resume.setCustomValidity(message); return message;
  };
  const validationErrors = () => {
    const resumeMessage = validResume(); const errors = [];
    for (const [name, label] of Object.entries(fieldNames)) {
      const control = field(name);
      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) || control.validity.valid) continue;
      const message = name === 'resume' && resumeMessage ? resumeMessage : control.validity.valueMissing ? `Enter ${label.toLowerCase()}.` : control.validationMessage;
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

  resume?.addEventListener('change', () => { const message = validResume(); if (message) showErrors([{ name: 'resume', message }], false); else clearErrors(); });
  form.addEventListener('input', () => { if (summary && !summary.hidden) clearErrors(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (accepted) return;
    const errors = validationErrors();
    if (errors.length) { form.reportValidity(); showErrors(errors); return; }
    clearErrors();
    const data = new FormData(form); const currentFingerprint = await fingerprint(data);
    if (currentFingerprint !== retryFingerprint) { retryFingerprint = currentFingerprint; retryKey = crypto.randomUUID(); }
    data.set('idempotencyKey', retryKey); setBusy(true);
    if (status) status.textContent = 'Submitting your application.';
    try {
      const response = await fetch('/api/applications', { method: 'POST', body: data, credentials: 'same-origin' }); const body = await response.json().catch(() => undefined);
      if (!response.ok || !body?.id) throw new Error('rejected');
      accepted = true; window.dispatchEvent(new CustomEvent('site-conversion', { detail: { form: 'application', accepted: true } })); setBusy(false);
      if (status) status.textContent = 'Your application has been received.';
    } catch {
      window.dispatchEvent(new CustomEvent('site-conversion', { detail: { form: 'application', accepted: false } })); setBusy(false);
      if (status) status.textContent = ''; setFormError('We could not submit your application. Check your connection and try again.');
    }
  });
})();
