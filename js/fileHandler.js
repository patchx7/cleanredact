/**
 * fileHandler.js
 * Drag & Drop + file input handling.
 * Validates type (PDF/image) and invokes the renderer.
 */

const MAX_FILE_SIZE_MB = 50;
const ACCEPTED_TYPES   = ['application/pdf','image/png','image/jpeg','image/jpg','image/webp'];

export const MAX_BATCH_FILES = 20;

/**
 * Attach drag-and-drop and click-to-choose to the drop zone.
 * @param {HTMLElement} dropZone
 * @param {HTMLInputElement} fileInput
 * @param {Function} onFile        callback(file:File, arrayBuffer:ArrayBuffer, type:'pdf'|'image')
 * @param {Function} [onBatchFiles] callback(files:File[]) for multi-file batch mode
 * @param {Function} [isBatchActive] callback():boolean returning whether batch view is active
 */
export function initFileHandler(dropZone, fileInput, onFile, onBatchFiles, isBatchActive) {
  // Drag events
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (!files || !files.length) return;

    const inBatch = isBatchActive && isBatchActive();
    if ((files.length > 1 || inBatch) && onBatchFiles) {
      handleBatchSelection(files, onBatchFiles);
    } else {
      processFile(files[0], onFile);
    }
  });

  // Click to choose (robust for both container and button)
  const chooseBtn = dropZone.querySelector('.btn-choose');
  const triggerPicker = e => {
    if (e) e.stopPropagation();
    fileInput.value = ''; // Allow re-selecting the exact same file
    fileInput.click();
  };

  dropZone.addEventListener('click', triggerPicker);
  if (chooseBtn) {
    chooseBtn.addEventListener('click', triggerPicker);
  }

  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files || !files.length) return;

    const inBatch = isBatchActive && isBatchActive();
    if ((files.length > 1 || inBatch) && onBatchFiles) {
      handleBatchSelection(files, onBatchFiles);
    } else {
      processFile(files[0], onFile);
    }
  });

  // Prevent default for drag over body, but allow batch drops
  document.addEventListener('dragover',  e => e.preventDefault());
  document.addEventListener('drop',      e => {
    e.preventDefault();
    const inBatch = isBatchActive && isBatchActive();
    if (inBatch && onBatchFiles && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleBatchSelection(e.dataTransfer.files, onBatchFiles);
    }
  });
}

/**
 * Filter and validate a batch of files, then invoke onBatchFiles.
 */
function handleBatchSelection(fileList, onBatchFiles) {
  const allFiles = Array.from(fileList);
  const validFiles = allFiles.filter(f => ACCEPTED_TYPES.includes(f.type) && f.size <= MAX_FILE_SIZE_MB * 1024 * 1024);

  if (validFiles.length === 0) {
    showToast('No supported files found (PDF, PNG, JPG under 50MB).', 'error');
    return;
  }

  if (validFiles.length > MAX_BATCH_FILES) {
    showToast(`Batch limit reached: Maximum ${MAX_BATCH_FILES} files allowed. Processing first ${MAX_BATCH_FILES}.`, 'info');
    onBatchFiles(validFiles.slice(0, MAX_BATCH_FILES));
  } else {
    onBatchFiles(validFiles);
  }
}

/**
 * Process a File: validate + read as ArrayBuffer, then call onFile.
 */
function processFile(file, onFile) {
  const t = window.__t || (k => k);

  if (!ACCEPTED_TYPES.includes(file.type)) {
    showToast('Unsupported file type. Use PDF, PNG, or JPG.', 'error');
    return;
  }
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    showToast(`File too large (max ${MAX_FILE_SIZE_MB} MB).`, 'error');
    return;
  }

  const fileType = file.type === 'application/pdf' ? 'pdf' : 'image';

  const reader = new FileReader();
  reader.onload = () => onFile(file, reader.result, fileType);
  reader.onerror = () => showToast('Could not read file.', 'error');
  reader.readAsArrayBuffer(file);
}

/**
 * Show a transient toast notification.
 * @param {string} msg
 * @param {'default'|'success'|'error'} type
 */
export function showToast(msg, type = 'default') {
  let toast = document.getElementById('cr-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cr-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  toast.classList.add('show');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.remove('show'), 3200);
}
