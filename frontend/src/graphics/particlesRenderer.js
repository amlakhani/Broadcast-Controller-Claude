// GPU particle renderer (WebGL2). Context-agnostic: works with a regular <canvas> on the main
// thread or an OffscreenCanvas inside a worker. Replaces the old per-frame Canvas 2D drawing
// (arc / createRadialGradient / path fills) — all shape rasterization now happens on the GPU
// via instanced quads, so the CPU only runs the lightweight particle simulation.

// Shape ids consumed by the fragment shader.
const SHAPE = {
    circle: 0, // snow, dust, stars, fireflies, default — soft filled disc
    bokeh: 1,  // radial gradient (white centre -> transparent)
    rect: 2,   // rain, confetti, digital — filled quad
    bubble: 3, // stroked ring + small shine highlight
    petal: 4,  // teardrop/leaf approximation
};

const VERT_SRC = `#version 300 es
in vec2 a_quad;       // base quad corner in [-0.5, 0.5]
in vec2 a_offset;     // particle centre, in pixels
in vec2 a_scale;      // quad size, in pixels
in float a_rotation;  // radians
in vec4 a_color;      // straight-alpha rgba (0..1)
uniform vec2 u_resolution;
out vec2 v_local;
out vec4 v_color;
void main() {
    float c = cos(a_rotation);
    float s = sin(a_rotation);
    vec2 p = a_quad * a_scale;
    vec2 rp = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    vec2 pos = a_offset + rp;
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y; // pixel space has +y down
    gl_Position = vec4(clip, 0.0, 1.0);
    v_local = a_quad;
    v_color = a_color;
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 v_local;
in vec4 v_color;
uniform int u_shape;
out vec4 frag;
void main() {
    vec2 lc = v_local * 2.0; // [-1, 1]
    float d = length(lc);
    float alpha = 1.0;
    if (u_shape == 0) {            // soft circle
        alpha = smoothstep(1.0, 0.85, d);
    } else if (u_shape == 1) {     // bokeh radial gradient
        alpha = clamp(1.0 - d, 0.0, 1.0);
    } else if (u_shape == 2) {     // filled rect (the quad itself)
        alpha = 1.0;
    } else if (u_shape == 3) {     // bubble: ring + shine
        float ring = smoothstep(0.14, 0.0, abs(d - 0.82)) * 0.5;
        float shine = smoothstep(0.30, 0.0, length(lc - vec2(-0.34, -0.34))) * 0.3;
        alpha = max(ring, shine);
    } else if (u_shape == 4) {     // petal / leaf
        float leaf = 1.0 - (lc.x * lc.x / 0.35 + lc.y * lc.y);
        alpha = smoothstep(0.0, 0.18, leaf);
    }
    if (alpha <= 0.0) discard;
    frag = vec4(v_color.rgb, v_color.a * alpha);
}`;

const FLOATS_PER_INSTANCE = 9; // offset(2) scale(2) rotation(1) color(4)

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('Shader compile failed: ' + log);
    }
    return sh;
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const WHITE = [1, 1, 1];

function maxCountFor(type) {
    switch (type) {
        case 'snow': return 150;
        case 'rain': return 200;
        case 'bokeh': return 30;
        case 'petals': return 40;
        case 'confetti': return 60;
        default: return 100;
    }
}

export class ParticleRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: true,
            depth: false,
            stencil: false,
        });
        this.supported = !!this.gl;
        this.width = 0;
        this.height = 0;
        this.params = null;        // { type, intensity, speed }
        this.particles = [];
        this.instanceData = null;  // Float32Array
        this.running = false;
        this.rafId = null;
        this._loop = this._loop.bind(this);
        if (this.supported) this._initGL();
    }

    _initGL() {
        const gl = this.gl;
        const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
        }
        this.program = prog;

        this.loc = {
            quad: gl.getAttribLocation(prog, 'a_quad'),
            offset: gl.getAttribLocation(prog, 'a_offset'),
            scale: gl.getAttribLocation(prog, 'a_scale'),
            rotation: gl.getAttribLocation(prog, 'a_rotation'),
            color: gl.getAttribLocation(prog, 'a_color'),
            resolution: gl.getUniformLocation(prog, 'u_resolution'),
            shape: gl.getUniformLocation(prog, 'u_shape'),
        };

        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        // Static unit quad (triangle strip).
        const quad = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
        this.quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.loc.quad);
        gl.vertexAttribPointer(this.loc.quad, 2, gl.FLOAT, false, 0, 0);

        // Per-instance interleaved buffer.
        this.instanceBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
        const stride = FLOATS_PER_INSTANCE * 4;
        const f = 4;
        const def = (loc, size, offset) => {
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
            gl.vertexAttribDivisor(loc, 1);
        };
        def(this.loc.offset, 2, 0);
        def(this.loc.scale, 2, 2 * f);
        def(this.loc.rotation, 1, 4 * f);
        def(this.loc.color, 4, 5 * f);

        gl.bindVertexArray(null);

        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
    }

    configure(params) {
        this.params = { type: 'dust', intensity: 50, speed: 50, ...params };
        this._reinit();
    }

    resize(width, height) {
        this.width = Math.max(1, Math.floor(width));
        this.height = Math.max(1, Math.floor(height));
        if (this.canvas.width !== this.width) this.canvas.width = this.width;
        if (this.canvas.height !== this.height) this.canvas.height = this.height;
        if (this.supported) {
            this.gl.viewport(0, 0, this.width, this.height);
        }
        this._reinit();
    }

    _reinit() {
        if (!this.supported || !this.params || !this.width || !this.height) return;
        const { type, intensity } = this.params;
        const count = Math.floor((intensity / 100) * maxCountFor(type));
        const list = new Array(count);
        for (let i = 0; i < count; i++) list[i] = this._createParticle();
        this.particles = list;
        this.instanceData = new Float32Array(count * FLOATS_PER_INSTANCE);
    }

    _createParticle() {
        const w = this.width;
        const h = this.height;
        const { type, speed } = this.params;
        const p = {
            x: Math.random() * w,
            y: Math.random() * h,
            size: Math.random() * 2 + 1,
            vx: (Math.random() - 0.5) * (speed / 50),
            vy: (Math.random() * 0.5 + 0.5) * (speed / 50),
            opacity: Math.random() * 0.5 + 0.2,
            color: WHITE,
            rotation: Math.random() * Math.PI * 2,
            vRotation: (Math.random() - 0.5) * 0.05,
            shape: SHAPE.circle,
        };

        if (type === 'snow') {
            p.size = Math.random() * 3 + 1;
            p.vx = (Math.random() - 0.5) * (speed / 100);
            p.vy = (Math.random() * 1 + 0.5) * (speed / 50);
        } else if (type === 'rain') {
            p.size = Math.random() * 1 + 0.5;
            p.vx = speed / 200;
            p.vy = (Math.random() * 10 + 10) * (speed / 50);
            p.opacity = Math.random() * 0.3 + 0.1;
            p.shape = SHAPE.rect;
        } else if (type === 'dust') {
            p.size = Math.random() * 1.5 + 0.5;
            p.vx = (Math.random() - 0.5) * (speed / 40);
            p.vy = (Math.random() - 0.5) * (speed / 40);
        } else if (type === 'bokeh') {
            p.size = Math.random() * 40 + 10;
            p.vx = (Math.random() - 0.5) * (speed / 80);
            p.vy = (Math.random() - 0.5) * (speed / 80);
            p.opacity = Math.random() * 0.15 + 0.05;
            p.shape = SHAPE.bokeh;
        } else if (type === 'stars') {
            p.size = Math.random() * 1.5 + 0.5;
            p.vx = 0;
            p.vy = 0;
            p.twinkle = Math.random() * 0.05 + 0.01;
            p.twinkleDir = 1;
        } else if (type === 'fireflies') {
            p.size = Math.random() * 3 + 1;
            p.color = hexToRgb('#e2ffad');
            p.vx = (Math.random() - 0.5) * (speed / 30);
            p.vy = (Math.random() - 0.5) * (speed / 30);
            p.opacity = Math.random() * 0.6 + 0.2;
        } else if (type === 'petals') {
            p.size = Math.random() * 6 + 4;
            p.color = hexToRgb(Math.random() > 0.5 ? '#ffb7c5' : '#ff9eb5');
            p.vx = (Math.random() * 1 + 0.5) * (speed / 60);
            p.vy = (Math.random() * 0.5 + 1) * (speed / 50);
            p.vRotation = (Math.random() - 0.5) * 0.02;
            p.shape = SHAPE.petal;
        } else if (type === 'bubbles') {
            p.size = Math.random() * 10 + 5;
            p.vx = Math.sin(Math.random() * Math.PI) * (speed / 50);
            p.vy = -(Math.random() * 1 + 0.5) * (speed / 50);
            p.opacity = Math.random() * 0.3 + 0.1;
            p.wobble = Math.random() * 10;
            p.shape = SHAPE.bubble;
        } else if (type === 'confetti') {
            const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
            p.size = Math.random() * 5 + 3;
            p.color = hexToRgb(colors[Math.floor(Math.random() * colors.length)]);
            p.vx = (Math.random() - 0.5) * (speed / 20);
            p.vy = (Math.random() * 2 + 2) * (speed / 50);
            p.w = p.size;
            p.h = p.size * 1.5;
            p.shape = SHAPE.rect;
        } else if (type === 'digital') {
            p.size = 2;
            p.color = hexToRgb('#00ff41');
            p.vx = 0;
            p.vy = (Math.random() * 5 + 5) * (speed / 50);
            p.opacity = Math.random() * 0.5 + 0.3;
            p.shape = SHAPE.rect;
        }
        return p;
    }

    start() {
        if (this.running || !this.supported) return;
        this.running = true;
        this.rafId = requestAnimationFrame(this._loop);
    }

    stop() {
        this.running = false;
        if (this.rafId != null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.supported && this.width && this.height) {
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        }
    }

    _loop() {
        if (!this.running) return;
        this._step();
        this._draw();
        this.rafId = requestAnimationFrame(this._loop);
    }

    // Advance the simulation (math ported 1:1 from the original Canvas 2D version) and pack the
    // per-instance attributes for the GPU.
    _step() {
        const { type, speed } = this.params;
        const w = this.width;
        const h = this.height;
        const data = this.instanceData;
        const parts = this.particles;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (type === 'bubbles') {
                p.x += Math.sin(p.wobble) * (speed / 100);
                p.wobble += 0.05;
            }
            p.x += p.vx;
            p.y += p.vy;
            p.rotation += p.vRotation;

            if (type === 'stars') {
                p.opacity += p.twinkle * p.twinkleDir;
                if (p.opacity > 0.8 || p.opacity < 0.1) p.twinkleDir *= -1;
            }

            if (p.x < -20) p.x = w + 20;
            if (p.x > w + 20) p.x = -20;
            if (p.y < -20) p.y = h + 20;
            if (p.y > h + 20) p.y = -20;

            // Per-type quad size and colour/alpha.
            let sx, sy, a;
            if (p.shape === SHAPE.rect) {
                if (type === 'rain') { sx = p.size; sy = 15; a = 0.4 * p.opacity; }
                else if (type === 'digital') { sx = 2; sy = 10; a = p.opacity; }
                else { sx = p.w; sy = p.h; a = p.opacity; } // confetti
            } else {
                sx = p.size * 2;
                sy = p.size * 2;
                a = p.opacity;
            }

            const o = i * FLOATS_PER_INSTANCE;
            data[o] = p.x;
            data[o + 1] = p.y;
            data[o + 2] = sx;
            data[o + 3] = sy;
            data[o + 4] = p.rotation;
            data[o + 5] = p.color[0];
            data[o + 6] = p.color[1];
            data[o + 7] = p.color[2];
            data[o + 8] = a;
        }
    }

    _draw() {
        const gl = this.gl;
        const count = this.particles.length;
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (count === 0) return;

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.uniform2f(this.loc.resolution, this.width, this.height);
        // All particles in one effect share a shape, so the uniform is set once per frame.
        gl.uniform1i(this.loc.shape, this.particles[0].shape);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData, gl.DYNAMIC_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.bindVertexArray(null);
    }

    destroy() {
        this.stop();
        const gl = this.gl;
        if (!gl) return;
        if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
        if (this.instanceBuf) gl.deleteBuffer(this.instanceBuf);
        if (this.vao) gl.deleteVertexArray(this.vao);
        if (this.program) gl.deleteProgram(this.program);
        this.particles = [];
        this.instanceData = null;
    }
}
