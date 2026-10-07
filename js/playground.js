/**
 * Playground app glue
 *
 * Wires the detector (js/detector-manager.js -> js/detector-worker.js ->
 * js/apriltag-wasm-wrapper.js -> js/apriltag_wasm.js/.wasm) to the UI:
 * camera capture, image upload, live overlay rendering (js/overlay-renderer.js),
 * detector tuning controls, a per-tag data table, and a small perf HUD.
 *
 * Architecture note: detection and rendering run as two independent
 * requestAnimationFrame loops on two canvases, following the pipeline this
 * detector was originally built and proven with:
 *   - processingCanvas: downscaled, grayscale-ready source fed to the wasm
 *     detector (detection is the expensive step, so it runs at whatever
 *     rate the worker can sustain)
 *   - displayCanvas: full resolution, redrawn every animation frame so the
 *     video feed stays smooth even while a detection is in flight
 * The two are decoupled deliberately: waiting for detection to finish before
 * drawing the next video frame would make the preview stutter at the
 * detector's frame rate instead of the display's.
 */
(() => {
    const detector = new AprilTagDetectorManager();

    // ---- DOM ----
    const video = document.getElementById('video');
    const processingCanvas = document.getElementById('processingCanvas');
    const displayCanvas = document.getElementById('displayCanvas');
    const processingCtx = processingCanvas.getContext('2d', { willReadFrequently: true });
    const displayCtx = displayCanvas.getContext('2d');

    const startCameraBtn = document.getElementById('startCameraBtn');
    const stopCameraBtn = document.getElementById('stopCameraBtn');
    const cameraSelect = document.getElementById('cameraSelect');
    const resolutionSelect = document.getElementById('resolutionSelect');
    const refreshCamerasBtn = document.getElementById('refreshCamerasBtn');

    const imageInput = document.getElementById('imageInput');
    const dropZone = document.getElementById('dropZone');

    const modeCameraBtn = document.getElementById('modeCameraBtn');
    const modeImageBtn = document.getElementById('modeImageBtn');
    const cameraPanel = document.getElementById('cameraPanel');
    const imagePanel = document.getElementById('imagePanel');

    const familyListEl = document.getElementById('familyList');
    const multiFamilyWarning = document.getElementById('multiFamilyWarning');

    const quadDecimateInput = document.getElementById('quadDecimate');
    const quadSigmaInput = document.getElementById('quadSigma');
    const refineEdgesInput = document.getElementById('refineEdges');
    const decodeSharpeningInput = document.getElementById('decodeSharpening');

    const overlayBoxInput = document.getElementById('overlayBox');
    const overlayCornersInput = document.getElementById('overlayCorners');
    const overlayCrosshairInput = document.getElementById('overlayCrosshair');
    const overlayLabelInput = document.getElementById('overlayLabel');
    const overlayMetricsInput = document.getElementById('overlayMetrics');

    const statusEl = document.getElementById('status');
    const fpsEl = document.getElementById('fpsValue');
    const detectMsEl = document.getElementById('detectMsValue');
    const tagCountEl = document.getElementById('tagCountValue');
    const resolutionValueEl = document.getElementById('resolutionValue');

    const dataTableBody = document.querySelector('#dataTable tbody');
    const copyJsonBtn = document.getElementById('copyJsonBtn');

    // ---- State ----
    let stream = null;
    let isRunning = false;
    let processingWidth = 640;
    let processingHeight = 480;
    let lastDetections = [];
    let lastProcessingTime = 0;
    let renderFrameCount = 0;
    let fps = 0;
    let fpsWindowStart = performance.now();
    let source = 'camera'; // 'camera' | 'image'
    let staticImageBitmap = null; // used while source === 'image'

    function setStatus(text) {
        statusEl.textContent = text;
    }

    function overlayOptions() {
        return {
            box: overlayBoxInput.checked,
            corners: overlayCornersInput.checked,
            crosshair: overlayCrosshairInput.checked,
            label: overlayLabelInput.checked,
            showMetrics: overlayMetricsInput.checked,
        };
    }

    // ---- Tag family UI ----
    function selectedFamilies() {
        return Array.from(familyListEl.querySelectorAll('.family-row'))
            .filter(row => row.querySelector('.family-checkbox').checked)
            .map(row => ({
                name: row.dataset.family,
                hamming: parseInt(row.querySelector('.family-hamming').value, 10),
            }));
    }

    function buildFamilyList() {
        familyListEl.innerHTML = '';
        TAG_FAMILIES.forEach(family => {
            const row = document.createElement('div');
            row.className = 'family-row';
            row.dataset.family = family.name;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'family-checkbox';
            checkbox.checked = family.name === 'tag36h11';

            const label = document.createElement('label');
            label.textContent = family.label;
            label.className = 'family-label';
            label.style.setProperty('--family-color', colorForFamily(family.name));

            const hamming = document.createElement('select');
            hamming.className = 'family-hamming';
            const maxHamming = family.maxHamming !== undefined ? family.maxHamming : 3;
            for (let h = family.minHamming; h <= maxHamming; h++) {
                const opt = document.createElement('option');
                opt.value = h;
                opt.textContent = `hamming ${h}`;
                hamming.appendChild(opt);
            }
            if (family.maxHamming !== undefined) {
                hamming.title = `${family.label} is fixed at hamming ${family.minHamming} in this build - see README "Known limitations"`;
                hamming.disabled = true;
            } else if (family.minHamming > 0) {
                hamming.title = `${family.label} requires hamming >= ${family.minHamming} to keep the false-positive rate acceptable`;
            }

            row.appendChild(checkbox);
            row.appendChild(label);
            row.appendChild(hamming);
            familyListEl.appendChild(row);

            checkbox.addEventListener('change', onFamilySelectionChanged);
            hamming.addEventListener('change', onFamilySelectionChanged);
        });
        updateMultiFamilyWarning();
    }

    function updateMultiFamilyWarning() {
        const n = selectedFamilies().length;
        multiFamilyWarning.style.display = n > 2 ? 'block' : 'none';
    }

    // Rapid checkbox toggles fire several 'change' events before the first
    // async applyFamilySelection() finishes. Rather than dropping the events
    // that land while one is in flight (which silently loses whichever
    // families were toggled during that window), coalesce them: remember
    // that another update is needed and run once more after the current one
    // completes, so the final call always reflects the settled checkbox state.
    let familyUpdateInFlight = false;
    let familyUpdatePending = false;
    async function onFamilySelectionChanged() {
        updateMultiFamilyWarning();
        if (!detector.initialized && !detector.initializing) return;
        if (familyUpdateInFlight) {
            familyUpdatePending = true;
            return;
        }
        familyUpdateInFlight = true;
        try {
            do {
                familyUpdatePending = false;
                await applyFamilySelection();
            } while (familyUpdatePending);
        } finally {
            familyUpdateInFlight = false;
        }
    }

    async function applyFamilySelection() {
        const families = selectedFamilies();
        if (families.length === 0) {
            setStatus('Select at least one tag family');
            return;
        }

        // detector.cleanupDetector() looks like the right tool for
        // reconfiguring without a full restart, but it isn't usable here:
        // cleaning up the C-side detector also flips the worker's own
        // "wasm loaded" flag off (js/detector-worker.js's cleanup()), which
        // then makes that worker permanently refuse any later setup call.
        // Terminating and recreating the worker sidesteps that - instantiating
        // an already browser-cached wasm module is fast, and terminate()
        // properly frees the old worker's heap instead of leaking it (which
        // is what naively calling initialize() again without terminate()
        // would do).
        detector.terminate();
        await detector.initialize({
            onDetectionResult: handleDetectionResult,
            onError: (msg) => setStatus(`Error: ${msg}`),
        });

        // Deliberately not using the C detector's initialize_detector("tagAll")
        // shortcut even when every family is selected: that path adds all 8
        // families at the same single hamming distance, which can't express
        // "each family gets its own hamming choice". Building the same end
        // state via setupDetector() + addFamily() is functionally identical
        // server-side and costs nothing but a few extra postMessage
        // round-trips.
        await detector.setupDetector(families[0].name, families[0].hamming, currentDetectorParams());

        for (let i = 1; i < families.length; i++) {
            await detector.addFamily(families[i].name, families[i].hamming);
        }
        setStatus(`Detecting: ${families.map(f => f.name).join(', ')}`);

        // Reconfiguring the detector doesn't retroactively touch whatever
        // was already drawn from the *previous* family selection - without
        // this, switching families after uploading an image leaves the
        // display and data table showing stale results from before the
        // switch. redetectStaticImage() itself sets a more specific status
        // ("Found N tag(s)") right after, superseding the line above.
        if (source === 'image') {
            await redetectStaticImage();
        }
    }

    function currentDetectorParams() {
        return {
            quadDecimate: parseFloat(quadDecimateInput.value),
            quadSigma: parseFloat(quadSigmaInput.value),
            refineEdges: refineEdgesInput.checked,
            decodeSharpening: parseFloat(decodeSharpeningInput.value),
        };
    }

    [quadDecimateInput, quadSigmaInput, refineEdgesInput, decodeSharpeningInput].forEach(el => {
        el.addEventListener('change', async () => {
            if (!detector.initialized) return;
            try {
                await detector.setParameters(currentDetectorParams());
                if (source === 'image') await redetectStaticImage();
            } catch (err) {
                console.error('Failed to update detector parameters:', err);
            }
        });
    });

    // Live-update the <output> readouts next to the range sliders.
    [quadDecimateInput, quadSigmaInput, decodeSharpeningInput].forEach(el => {
        const output = document.querySelector(`output[for="${el.id}"]`);
        if (!output) return;
        el.addEventListener('input', () => { output.textContent = el.value; });
    });

    // ---- Detection result handling ----
    function handleDetectionResult(detections, processingTime) {
        lastDetections = detections;
        lastProcessingTime = processingTime;
        detectMsEl.textContent = processingTime.toFixed(1);
        tagCountEl.textContent = detections.length;
        updateDataTable(detections);
    }

    function updateDataTable(detections) {
        dataTableBody.innerHTML = '';
        detections.forEach(det => {
            const row = document.createElement('tr');
            const corners = det.corners.map(c => `(${c.x.toFixed(0)},${c.y.toFixed(0)})`).join(' ');
            row.innerHTML = `
                <td>${det.id}</td>
                <td>${det.family}</td>
                <td>${det.center.x.toFixed(1)}, ${det.center.y.toFixed(1)}</td>
                <td class="corners-cell">${corners}</td>
                <td>${det.decisionMargin.toFixed(1)}</td>
                <td>${det.hamming}</td>
                <td>${det.rotation.toFixed(2)}</td>
            `;
            dataTableBody.appendChild(row);
        });
    }

    copyJsonBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify(lastDetections, null, 2));
            copyJsonBtn.textContent = 'Copied!';
            setTimeout(() => { copyJsonBtn.textContent = 'Copy as JSON'; }, 1200);
        } catch (err) {
            console.error('Clipboard write failed:', err);
        }
    });

    // ---- Camera handling ----
    async function populateCameraDevices() {
        try {
            cameraSelect.innerHTML = '<option value="">Loading cameras...</option>';

            const permissionStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            permissionStream.getTracks().forEach(track => track.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            cameraSelect.innerHTML = '';
            if (videoDevices.length === 0) {
                cameraSelect.innerHTML = '<option value="">No cameras found</option>';
                return;
            }

            videoDevices.forEach((device, i) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                let label = device.label || `Camera ${i + 1}`;
                if (/back|environment/i.test(label)) label += ' (Back)';
                else if (/front|user/i.test(label)) label += ' (Front)';
                option.text = label;
                cameraSelect.appendChild(option);
            });

            const backCamera = videoDevices.find(d => /back|environment|rear/i.test(d.label))
                || videoDevices.find(d => !/front|user/i.test(d.label));
            if (backCamera) cameraSelect.value = backCamera.deviceId;
        } catch (err) {
            console.error('Error enumerating cameras:', err);
            cameraSelect.innerHTML = '<option value="">Camera access needed to list devices</option>';
        }
    }

    async function getCameraStream() {
        const [w, h] = resolutionSelect.value.split('x').map(Number);
        const deviceId = cameraSelect.value;

        const exactConstraints = {
            video: deviceId
                ? { deviceId: { exact: deviceId }, width: { exact: w }, height: { exact: h } }
                : { facingMode: { exact: 'environment' }, width: { exact: w }, height: { exact: h } },
        };

        try {
            return await navigator.mediaDevices.getUserMedia(exactConstraints);
        } catch (exactError) {
            console.log('Exact constraints failed, retrying with ideal constraints:', exactError.message);
            const idealConstraints = {
                video: deviceId
                    ? { deviceId: { exact: deviceId }, width: { ideal: w }, height: { ideal: h } }
                    : { facingMode: { ideal: 'environment' }, width: { ideal: w }, height: { ideal: h } },
            };
            return await navigator.mediaDevices.getUserMedia(idealConstraints);
        }
    }

    async function startCamera() {
        try {
            setStatus('Requesting camera access...');
            stream = await getCameraStream();
            video.srcObject = stream;
            await video.play();

            const track = stream.getVideoTracks()[0];
            const settings = track.getSettings();
            processingWidth = Math.min(settings.width || 640, 640);
            processingHeight = Math.round(processingWidth * (settings.height || 480) / (settings.width || 640));
            processingCanvas.width = processingWidth;
            processingCanvas.height = processingHeight;
            displayCanvas.width = settings.width || 640;
            displayCanvas.height = settings.height || 480;
            resolutionValueEl.textContent = `${displayCanvas.width}x${displayCanvas.height}`;

            startCameraBtn.disabled = true;
            stopCameraBtn.disabled = false;

            isRunning = true;
            requestAnimationFrame(processFrame);
            requestAnimationFrame(renderFrame);
            setStatus('Camera running');
        } catch (err) {
            console.error('Failed to start camera:', err);
            setStatus(`Camera error: ${err.message}`);
        }
    }

    function stopCamera() {
        isRunning = false;
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            stream = null;
        }
        video.srcObject = null;
        startCameraBtn.disabled = false;
        stopCameraBtn.disabled = true;
        setStatus('Camera stopped');
    }

    // ---- Frame loops (camera mode) ----
    function processFrame() {
        if (!isRunning || source !== 'camera') return;
        requestAnimationFrame(processFrame);

        if (!detector.initialized || detector.getStatus().busy) return;

        try {
            processingCtx.drawImage(video, 0, 0, processingWidth, processingHeight);
            const imageData = processingCtx.getImageData(0, 0, processingWidth, processingHeight);
            detector.detect(imageData, processingWidth, processingHeight).catch(err => {
                console.error('Detection error:', err);
            });
        } catch (err) {
            console.error('Frame processing error:', err);
        }
    }

    function renderFrame() {
        if (!isRunning || source !== 'camera') return;
        requestAnimationFrame(renderFrame);

        displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        if (video.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
            displayCtx.drawImage(video, 0, 0, displayCanvas.width, displayCanvas.height);
        }
        const scaleX = displayCanvas.width / processingWidth;
        const scaleY = displayCanvas.height / processingHeight;
        drawDetections(displayCtx, lastDetections, scaleX, scaleY, overlayOptions());

        trackFps();
    }

    function trackFps() {
        renderFrameCount++;
        const now = performance.now();
        const elapsed = now - fpsWindowStart;
        if (elapsed >= 500) {
            fps = Math.round((renderFrameCount * 1000) / elapsed);
            fpsEl.textContent = fps;
            renderFrameCount = 0;
            fpsWindowStart = now;
        }
    }

    // ---- Image upload mode ----
    async function handleImageFile(file) {
        if (!file || !file.type.startsWith('image/')) return;
        const bitmap = await createImageBitmap(file);
        staticImageBitmap = bitmap;

        displayCanvas.width = bitmap.width;
        displayCanvas.height = bitmap.height;

        // Detect at a downscaled copy for speed, same as the live-camera path.
        const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
        processingWidth = Math.round(bitmap.width * scale);
        processingHeight = Math.round(bitmap.height * scale);
        processingCanvas.width = processingWidth;
        processingCanvas.height = processingHeight;

        await redetectStaticImage();
    }

    // Re-runs detection on the currently loaded static image against
    // whatever families/parameters are active *right now*, and redraws.
    // Called both right after an image is loaded and whenever family
    // selection or detector parameters change while in image mode -
    // without this, switching families after uploading an image would
    // reconfigure the detector but leave the displayed result and data
    // table showing whatever was detected under the *previous* selection.
    async function redetectStaticImage() {
        if (!staticImageBitmap) return;

        displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        displayCtx.drawImage(staticImageBitmap, 0, 0);
        processingCtx.drawImage(staticImageBitmap, 0, 0, processingWidth, processingHeight);

        if (!detector.initialized) {
            setStatus('Detector still loading, please wait...');
            return;
        }

        const imageData = processingCtx.getImageData(0, 0, processingWidth, processingHeight);
        setStatus('Detecting...');
        // detect()'s own resolved value is not a reliable source of the
        // detections array (its shape differs across the manager's internal
        // code paths - see js/detector-manager.js). The onDetectionResult
        // callback registered in main() is what actually receives the
        // parsed array, and it runs synchronously inside the same worker
        // message handler that resolves this promise, so lastDetections is
        // already up to date by the time this await resumes.
        await detector.detect(imageData, processingWidth, processingHeight);
        const detections = lastDetections;

        const scaleX = displayCanvas.width / processingWidth;
        const scaleY = displayCanvas.height / processingHeight;
        drawDetections(displayCtx, detections, scaleX, scaleY, overlayOptions());
        setStatus(`Found ${detections.length} tag(s)`);
    }

    imageInput.addEventListener('change', () => {
        if (!imageInput.files[0]) return;
        const file = imageInput.files[0];
        // Reset the input's value once its file is captured. Without this,
        // choosing the exact same file again - e.g. switching tag family,
        // then re-picking the same test image - doesn't fire a new 'change'
        // event at all (the browser sees the value as unchanged), so
        // detection silently never re-runs for the new family.
        imageInput.value = '';
        handleImageFile(file);
    });

    ['dragenter', 'dragover'].forEach(evt => {
        dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach(evt => {
        dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    });
    dropZone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files[0];
        if (file) handleImageFile(file);
    });
    dropZone.addEventListener('click', () => imageInput.click());

    // Re-render the last still with current overlay toggles without re-detecting.
    [overlayBoxInput, overlayCornersInput, overlayCrosshairInput, overlayLabelInput, overlayMetricsInput].forEach(el => {
        el.addEventListener('change', () => {
            if (source === 'image' && staticImageBitmap) {
                displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
                displayCtx.drawImage(staticImageBitmap, 0, 0);
                const scaleX = displayCanvas.width / processingWidth;
                const scaleY = displayCanvas.height / processingHeight;
                drawDetections(displayCtx, lastDetections, scaleX, scaleY, overlayOptions());
            }
        });
    });

    // ---- Mode switching ----
    function setMode(newMode) {
        source = newMode;
        modeCameraBtn.classList.toggle('active', newMode === 'camera');
        modeImageBtn.classList.toggle('active', newMode === 'image');
        cameraPanel.style.display = newMode === 'camera' ? 'block' : 'none';
        imagePanel.style.display = newMode === 'image' ? 'block' : 'none';
        dropZone.classList.toggle('visible', newMode === 'image');

        if (newMode === 'image' && isRunning) {
            stopCamera();
        }
    }
    modeCameraBtn.addEventListener('click', () => setMode('camera'));
    modeImageBtn.addEventListener('click', () => setMode('image'));

    // ---- Wire up remaining controls ----
    startCameraBtn.addEventListener('click', startCamera);
    stopCameraBtn.addEventListener('click', stopCamera);
    refreshCamerasBtn.addEventListener('click', populateCameraDevices);

    // ---- Boot ----
    async function main() {
        buildFamilyList();
        setMode('camera');
        setStatus('Loading AprilTag WebAssembly module...');

        // applyFamilySelection() owns detector.initialize() (see its own
        // comment above) - detector.terminate() is a safe no-op on a
        // never-started manager, so this cold-start call goes through the
        // same path as every later family change instead of duplicating it.
        await applyFamilySelection();
        await populateCameraDevices();
        setStatus('Ready. Click "Start Camera" or drop an image.');
    }

    main().catch(err => {
        console.error('Startup failed:', err);
        setStatus(`Startup failed: ${err.message}`);
    });
})();
