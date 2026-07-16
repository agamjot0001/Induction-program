/**
 * GLOBALS & CONFIG
 */
const videoElement = document.querySelector('.input_video');
const bgCanvas = document.getElementById('bgCanvas');
const mainCanvas = document.getElementById('mainCanvas');
const bgCtx = bgCanvas.getContext('2d');
const ctx = mainCanvas.getContext('2d');

let width = window.innerWidth;
let height = window.innerHeight;

let time = 0;
let lastTime = performance.now();
let framesThisSecond = 0;
let lastFpsTime = performance.now();

let currentHands = []; // Latest data from MediaPipe
let handVelocities = 0; // Average hand movement speed

// Theme Config
let currentTheme = 'Rainbow';
const themes = {
    'Rainbow':   (t, index, total) => `hsl(${(t * 100 + index * (360/total)) % 360}, 100%, 60%)`,
    'Cyberpunk': (t, index, total) => (index % 2 === 0) ? '#ff003c' : '#00f0ff',
    'Lava':      (t, index, total) => `hsl(${(10 + (index * 10)) % 40}, 100%, ${50 + Math.sin(t)*10}%)`,
    'Ocean':     (t, index, total) => `hsl(${180 + (index * 20)}, 100%, 60%)`,
    'Galaxy':    (t, index, total) => `hsl(${260 + Math.sin(t*2 + index)*40}, 100%, 65%)`
};

// Physics Engines Data
let particles = [];
let ripples = [];

// Landmark indices for each finger's tip / pip(-equivalent) / mcp joints.
// Used to test whether a finger is open (extended) or closed (curled).
const FINGERS = [
    { name: 'thumb',  tip: 4,  pip: 3,  mcp: 2  },
    { name: 'index',  tip: 8,  pip: 6,  mcp: 5  },
    { name: 'middle', tip: 12, pip: 10, mcp: 9  },
    { name: 'ring',   tip: 16, pip: 14, mcp: 13 },
    { name: 'pinky',  tip: 20, pip: 18, mcp: 17 }
];
// A finger counts as "open" when its tip sits meaningfully farther from the
// wrist than its pip joint does. This is rotation-independent, so it still
// works no matter how the hand is angled toward the camera.
const EXTEND_RATIO = 1.15;

function isFingerExtended(hand, finger) {
    const wrist = hand[0];
    const tipDist = getDist(wrist, hand[finger.tip]);
    const pipDist = getDist(wrist, hand[finger.pip]);
    return tipDist > pipDist * EXTEND_RATIO;
}

// Orders any number (>=3) of points around their shared centroid so a
// polygon connecting them doesn't self-intersect
function orderPointsAroundCentroid(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return pts.slice().sort((a, b) =>
        Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
    );
}

// Fills the polygon formed by every currently-open fingertip with a shifting
// color gradient, then adds a frosted, black-and-white "glass" sheen that
// drifts across it, on top of a glowing outline.
function drawPolygonFill(pts) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();

    const xs = pts.map(p => p.x);
    const ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const diag = Math.max(Math.hypot(maxX - minX, maxY - minY), 40);

    // 1. Colorful animated base fill
    const colorGrad = ctx.createLinearGradient(minX, minY, maxX, maxY);
    const stops = Math.max(pts.length, 4);
    for (let i = 0; i <= stops; i++) {
        colorGrad.addColorStop(i / stops, themes[currentTheme](time * 0.6 + i * 0.3, i, stops + 1));
    }
    ctx.fillStyle = colorGrad;
    ctx.globalAlpha = 0.5;
    ctx.shadowBlur = 25;
    ctx.shadowColor = themes[currentTheme](time, 0, 1);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 2. Frosted glass black & white sheen, clipped to the same polygon,
    //    drifting like a light source orbiting the shape
    ctx.save();
    ctx.clip();
    const lightX = cx + Math.cos(time * 0.6) * diag * 0.3;
    const lightY = cy + Math.sin(time * 0.6) * diag * 0.3;
    const sheen = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, diag * 0.65);
    sheen.addColorStop(0, 'rgba(255,255,255,0.65)');
    sheen.addColorStop(0.4, 'rgba(255,255,255,0.08)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = sheen;
    ctx.fillRect(minX - 20, minY - 20, (maxX - minX) + 40, (maxY - minY) + 40);
    ctx.restore();

    // 3. Glowing outline
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.shadowBlur = 15;
    ctx.shadowColor = themes[currentTheme](time, 2, 4);
    ctx.stroke();
    ctx.restore();

    drawPerimeterPulse(pts);
}

// Cool effect: a couple of bright energy pulses continuously race around the
// polygon's perimeter, like current tracing a circuit
function drawPerimeterPulse(pts) {
    const n = pts.length;
    if (n < 3) return;

    const edges = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const len = getDist(a, b);
        edges.push({ a, b, len });
        total += len;
    }
    if (total === 0) return;

    const pulseCount = 2;
    for (let p = 0; p < pulseCount; p++) {
        const t = ((time * 0.15) + p / pulseCount) % 1;
        let dist = t * total;
        for (const e of edges) {
            if (dist <= e.len) {
                const frac = e.len === 0 ? 0 : dist / e.len;
                const x = e.a.x + (e.b.x - e.a.x) * frac;
                const y = e.a.y + (e.b.y - e.a.y) * frac;
                const col = themes[currentTheme](time + p, p, pulseCount + 1);
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.shadowBlur = 20;
                ctx.shadowColor = col;
                ctx.fill();
                ctx.shadowBlur = 0;
                break;
            }
            dist -= e.len;
        }
    }
}


// Matrix Background
let matrixColumns = [];
const fontSize = 16;
let maxColumns = 0;

// Audio Node References
let audioCtx = null;
let humOsc = null;
let humGain = null;

// UI Elements
const uiHands = document.getElementById('ui-hands');
const uiFps = document.getElementById('ui-fps');
const uiGesture = document.getElementById('ui-gesture');
const uiSpread = document.getElementById('ui-spread');
const uiOpen = document.getElementById('ui-open');

/**
 * INITIALIZATION
 */
function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    bgCanvas.width = width;
    bgCanvas.height = height;
    mainCanvas.width = width;
    mainCanvas.height = height;

    maxColumns = Math.floor(width / fontSize);
    matrixColumns = new Array(maxColumns).fill(1).map(() => Math.random() * height/fontSize);
}
window.addEventListener('resize', resize);
resize();

// UI Theme Switcher
document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentTheme = e.target.getAttribute('data-theme');
        document.documentElement.style.setProperty('--accent', themes[currentTheme](0, 1, 1));
    });
});

// Start button triggers AudioContext and hides overlay
document.getElementById('startBtn').addEventListener('click', () => {
    document.getElementById('startOverlay').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('themes').classList.remove('hidden');
    initAudio();
    initMediaPipe();
    requestAnimationFrame(renderLoop);
});


/**
 * AUDIO ENGINE
 */
function initAudio() {
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Continuous Hum
        humOsc = audioCtx.createOscillator();
        humGain = audioCtx.createGain();

        humOsc.type = 'sine';
        humOsc.frequency.value = 100;

        humGain.gain.value = 0; // Mute until hands are seen

        humOsc.connect(humGain);
        humGain.connect(audioCtx.destination);
        humOsc.start();
    } catch(e) {
        console.error("Web Audio API failed", e);
    }
}

function triggerZap() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    // Zap sound profile
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(800, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.1);

    gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
}

function updateHum(activeHands) {
    if (!audioCtx || !humGain) return;
    if (activeHands.length < 2) {
        humGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
        return;
    }

    // Measure distance between index fingers to modulate volume
    const p1 = activeHands[0][8];
    const p2 = activeHands[1][8];
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dist = Math.sqrt(dx*dx + dy*dy);

    // The closer they are, the higher the pitch and volume
    const targetFreq = 100 + (1 - Math.min(dist, 1)) * 300;
    const targetVolume = 0.05 + (1 - Math.min(dist, 1)) * 0.15;

    humOsc.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.1);
    humGain.gain.setTargetAtTime(targetVolume, audioCtx.currentTime, 0.1);
}

/**
 * MATH & STATE LOGIC
 */
function getDist(p1, p2) {
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// Convert normalized landmark to specific canvas scale (Note: canvas is horizontally flipped)
function mapToCanvas(point) {
    return { x: point.x * width, y: point.y * height };
}

let lastPinchState = [false, false]; // Prevents rapid re-triggering

function detectGestures() {
    if (!currentHands.length) return;

    currentHands.forEach((hand, idx) => {
        // Pinch Detection: Thumb (4) and Index (8)
        const thumb = hand[4];
        const index = hand[8];
        const dist = getDist(thumb, index);

        const isPinching = dist < 0.05; // 5% of screen screen distance

        if (isPinching && !lastPinchState[idx]) {
            const midpoint = {
                x: (thumb.x + index.x) / 2,
                y: (thumb.y + index.y) / 2
            };
            createShockwave(mapToCanvas(midpoint), themes[currentTheme](time, 1, 1));
            triggerZap();
            uiGesture.innerText = "PINCH !";
        }
        lastPinchState[idx] = isPinching;
    });

    // Spread Percentage estimated by distance between Thumb(4) and Index(8)
    if (currentHands[0]) {
        const spread = getDist(currentHands[0][4], currentHands[0][8]);
        // Normalizing spread so max is around 100%
        let spreadPct = Math.min(Math.round(spread * 400), 100);
        uiSpread.innerText = spreadPct + '%';
        if (!lastPinchState.includes(true)) {
            uiGesture.innerText = spreadPct > 50 ? "Open Hand" : "Fist";
        }
    }
}

/**
 * EFFECTS & PHYSICS
 */
function createParticles(pos, color, count = 3) {
    for (let i=0; i<count; i++) {
        particles.push({
            x: pos.x,
            y: pos.y,
            vx: (Math.random() - 0.5) * 8,
            vy: (Math.random() - 0.5) * 8,
            life: 1.0,
            color: color,
            size: Math.random() * 3 + 1
        });
    }
}

function createShockwave(pos, color) {
    ripples.push({
        x: pos.x,
        y: pos.y,
        radius: 0,
        maxRadius: 150 + Math.random() * 100,
        life: 1.0,
        color: color
    });
}

// Background Effect Engine
function drawBackground() {
    // Use destination-out to fade out the previous frame's drops, leaving a transparent trail
    bgCtx.globalCompositeOperation = 'destination-out';
    bgCtx.fillStyle = `rgba(0, 0, 0, ${0.15 + Math.min(handVelocities*10, 0.5)})`;
    bgCtx.fillRect(0, 0, width, height);
    bgCtx.globalCompositeOperation = 'source-over';

    // Matrix Rain Effect mapping to hand speed
    bgCtx.fillStyle = themes[currentTheme](time, 1, 1);
    bgCtx.font = fontSize + "px monospace";

    // Matrix speed boosts when hands move fast
    let speedMult = 1 + (handVelocities * 100);

    for (let i = 0; i < matrixColumns.length; i++) {
        // Only draw randomly to keep it sparse like stars/rain
        if (Math.random() > 0.95) {
            const char = String.fromCharCode(0x30A0 + Math.random() * 96);
            bgCtx.fillText(char, i * fontSize, matrixColumns[i] * fontSize);
        }

        matrixColumns[i] += Math.random() * speedMult;

        if (matrixColumns[i] * fontSize > height && Math.random() > 0.9) {
            matrixColumns[i] = 0;
        }
    }
}

function updatePhysics() {
    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.02;     // Fade out
        p.vy += 0.1;        // Gravity

        if (p.life <= 0) {
            particles.splice(i, 1);
        } else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = p.life;
            ctx.fill();
        }
    }

    // Ripples / Shockwaves
    for (let i = ripples.length - 1; i >= 0; i--) {
        let r = ripples[i];
        r.radius += (r.maxRadius - r.radius) * 0.1; // Ease out
        r.life -= 0.03;

        if (r.life <= 0) {
            ripples.splice(i, 1);
        } else {
            ctx.beginPath();
            ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
            ctx.strokeStyle = r.color;
            ctx.lineWidth = 4 * r.life;
            ctx.globalAlpha = r.life;
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1.0; // Reset
}

/**
 * MAIN RENDER PIPELINE
 */
function renderLoop(timestamp) {
    requestAnimationFrame(renderLoop);

    let dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    time += dt;

    // Update FPS Counter
    framesThisSecond++;
    if (timestamp > lastFpsTime + 1000) {
        uiFps.innerText = framesThisSecond;
        framesThisSecond = 0;
        lastFpsTime = timestamp;
    }

    drawBackground();

    // The main canvas will clear fully each frame since we handle ghosting via bgCanvas
    // BUT user requested trailing motion blur for fingertips.
    // Instead of clearRect, we fade the main canvas using destination-out to keep it transparent
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, 0, width, height);

    // Enable Screen mode for additive light effects (like neon bloom)
    ctx.globalCompositeOperation = 'screen'; // Creates glowy overlapping effects

    // Render Physics layer
    updatePhysics();

    // Process Hand Logic if present
    if (currentHands.length > 0) {

        // 1. Per hand: find which fingers are OPEN, draw glowing markers +
        //    a connecting trace only across those, and collect their tips
        let allOpenPts = [];
        let totalOpenCount = 0;

        currentHands.forEach((hand, handIndex) => {
            const glowColor = themes[currentTheme](time, handIndex, 2);

            const openFingers = FINGERS.filter(f => isFingerExtended(hand, f));
            const openPts = openFingers.map(f => mapToCanvas(hand[f.tip]));
            totalOpenCount += openPts.length;

            // Trace a line across this hand's open fingertips (anatomical order)
            if (openPts.length > 1) {
                ctx.beginPath();
                ctx.moveTo(openPts[0].x, openPts[0].y);
                for (let i = 1; i < openPts.length; i++) ctx.lineTo(openPts[i].x, openPts[i].y);
                ctx.strokeStyle = glowColor;
                ctx.lineWidth = 2;
                ctx.shadowBlur = 12;
                ctx.shadowColor = glowColor;
                ctx.stroke();
            }

            // Glowing markers + sparks only on open fingertips; closed
            // fingers are ignored entirely, as if invisible to the sensor
            ctx.shadowBlur = 15;
            ctx.shadowColor = glowColor;
            openPts.forEach((pt, idx) => {
                const tipCol = themes[currentTheme](time, idx, Math.max(openPts.length, 1));
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();

                if (Math.random() > 0.55) {
                    createParticles(pt, tipCol, 1);
                }
            });
            ctx.shadowBlur = 0; // Reset

            allOpenPts = allOpenPts.concat(openPts);
        });

        if (uiOpen) uiOpen.innerText = totalOpenCount;

        // 2. Combine every open fingertip across both hands into one
        //    shape, filled with color + a black-and-white glass sheen,
        //    and traced by traveling energy pulses. Needs 3+ open fingers
        //    to form a shape at all — it grows and shrinks live as fingers
        //    open and close.
        if (allOpenPts.length >= 3) {
            const orderedPts = orderPointsAroundCentroid(allOpenPts);
            drawPolygonFill(orderedPts);

            // Occasional ambient sparks along the shape's corners
            if (Math.random() > 0.7) {
                const randPt = orderedPts[Math.floor(Math.random() * orderedPts.length)];
                createParticles(randPt, themes[currentTheme](time, 1, 1), 1);
            }
        }

        detectGestures();
    }


    ctx.globalCompositeOperation = 'source-over'; // Restore
}

/**
 * MEDIAPIPE INITIALIZATION
 */
function initMediaPipe() {
    const hands = new Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});

    hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7
    });

    hands.onResults((results) => {
        if (!audioCtx) return; // Wait for initialization

        // Update global state for render loop to read from
        uiHands.innerText = results.multiHandLandmarks ? results.multiHandLandmarks.length : 0;

        // Calculate velocity (rudimentary)
        if (currentHands.length > 0 && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            let vSum = 0;
            // check distance difference on index finger of hand 0
            const oldP = currentHands[0][8];
            const newP = results.multiHandLandmarks[0][8];
            if (oldP && newP) {
                vSum += getDist(oldP, newP);
                handVelocities = vSum;
            }
        } else {
            handVelocities = 0;
        }

        currentHands = results.multiHandLandmarks || [];
        updateHum(currentHands);
    });

    const camera = new Camera(videoElement, {
        onFrame: async () => {
            await hands.send({image: videoElement});
        },
        width: 1280,
        height: 720,
        facingMode: 'user'
    });

    camera.start();
}
