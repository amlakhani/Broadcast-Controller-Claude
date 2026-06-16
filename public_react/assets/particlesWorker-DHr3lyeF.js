(function(){let e={circle:0,bokeh:1,rect:2,bubble:3,petal:4};function t(e,t,n){let r=e.createShader(t);if(e.shaderSource(r,n),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS)){let t=e.getShaderInfoLog(r);throw e.deleteShader(r),Error(`Shader compile failed: `+t)}return r}function n(e){let t=parseInt(e.slice(1),16);return[(t>>16&255)/255,(t>>8&255)/255,(t&255)/255]}let r=[1,1,1];function i(e){switch(e){case`snow`:return 150;case`rain`:return 200;case`bokeh`:return 30;case`petals`:return 40;case`confetti`:return 60;default:return 100}}var a=class{constructor(e){this.canvas=e,this.gl=e.getContext(`webgl2`,{alpha:!0,premultipliedAlpha:!1,antialias:!0,depth:!1,stencil:!1}),this.supported=!!this.gl,this.width=0,this.height=0,this.params=null,this.particles=[],this.instanceData=null,this.running=!1,this.rafId=null,this._loop=this._loop.bind(this),this.supported&&this._initGL()}_initGL(){let e=this.gl,n=t(e,e.VERTEX_SHADER,`#version 300 es
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
}`),r=t(e,e.FRAGMENT_SHADER,`#version 300 es
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
}`),i=e.createProgram();if(e.attachShader(i,n),e.attachShader(i,r),e.linkProgram(i),!e.getProgramParameter(i,e.LINK_STATUS))throw Error(`Program link failed: `+e.getProgramInfoLog(i));this.program=i,this.loc={quad:e.getAttribLocation(i,`a_quad`),offset:e.getAttribLocation(i,`a_offset`),scale:e.getAttribLocation(i,`a_scale`),rotation:e.getAttribLocation(i,`a_rotation`),color:e.getAttribLocation(i,`a_color`),resolution:e.getUniformLocation(i,`u_resolution`),shape:e.getUniformLocation(i,`u_shape`)},this.vao=e.createVertexArray(),e.bindVertexArray(this.vao);let a=new Float32Array([-.5,-.5,.5,-.5,-.5,.5,.5,.5]);this.quadBuf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.quadBuf),e.bufferData(e.ARRAY_BUFFER,a,e.STATIC_DRAW),e.enableVertexAttribArray(this.loc.quad),e.vertexAttribPointer(this.loc.quad,2,e.FLOAT,!1,0,0),this.instanceBuf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.instanceBuf);let o=(t,n,r)=>{e.enableVertexAttribArray(t),e.vertexAttribPointer(t,n,e.FLOAT,!1,36,r),e.vertexAttribDivisor(t,1)};o(this.loc.offset,2,0),o(this.loc.scale,2,8),o(this.loc.rotation,1,16),o(this.loc.color,4,20),e.bindVertexArray(null),e.disable(e.DEPTH_TEST),e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA),e.clearColor(0,0,0,0)}configure(e){this.params={type:`dust`,intensity:50,speed:50,...e},this._reinit()}resize(e,t){this.width=Math.max(1,Math.floor(e)),this.height=Math.max(1,Math.floor(t)),this.canvas.width!==this.width&&(this.canvas.width=this.width),this.canvas.height!==this.height&&(this.canvas.height=this.height),this.supported&&this.gl.viewport(0,0,this.width,this.height),this._reinit()}_reinit(){if(!this.supported||!this.params||!this.width||!this.height)return;let{type:e,intensity:t}=this.params,n=Math.floor(t/100*i(e)),r=Array(n);for(let e=0;e<n;e++)r[e]=this._createParticle();this.particles=r,this.instanceData=new Float32Array(n*9)}_createParticle(){let t=this.width,i=this.height,{type:a,speed:o}=this.params,s={x:Math.random()*t,y:Math.random()*i,size:Math.random()*2+1,vx:(Math.random()-.5)*(o/50),vy:(Math.random()*.5+.5)*(o/50),opacity:Math.random()*.5+.2,color:r,rotation:Math.random()*Math.PI*2,vRotation:(Math.random()-.5)*.05,shape:e.circle};if(a===`snow`)s.size=Math.random()*3+1,s.vx=(Math.random()-.5)*(o/100),s.vy=(Math.random()*1+.5)*(o/50);else if(a===`rain`)s.size=Math.random()*1+.5,s.vx=o/200,s.vy=(Math.random()*10+10)*(o/50),s.opacity=Math.random()*.3+.1,s.shape=e.rect;else if(a===`dust`)s.size=Math.random()*1.5+.5,s.vx=(Math.random()-.5)*(o/40),s.vy=(Math.random()-.5)*(o/40);else if(a===`bokeh`)s.size=Math.random()*40+10,s.vx=(Math.random()-.5)*(o/80),s.vy=(Math.random()-.5)*(o/80),s.opacity=Math.random()*.15+.05,s.shape=e.bokeh;else if(a===`stars`)s.size=Math.random()*1.5+.5,s.vx=0,s.vy=0,s.twinkle=Math.random()*.05+.01,s.twinkleDir=1;else if(a===`fireflies`)s.size=Math.random()*3+1,s.color=n(`#e2ffad`),s.vx=(Math.random()-.5)*(o/30),s.vy=(Math.random()-.5)*(o/30),s.opacity=Math.random()*.6+.2;else if(a===`petals`)s.size=Math.random()*6+4,s.color=n(Math.random()>.5?`#ffb7c5`:`#ff9eb5`),s.vx=(Math.random()*1+.5)*(o/60),s.vy=(Math.random()*.5+1)*(o/50),s.vRotation=(Math.random()-.5)*.02,s.shape=e.petal;else if(a===`bubbles`)s.size=Math.random()*10+5,s.vx=Math.sin(Math.random()*Math.PI)*(o/50),s.vy=-(Math.random()*1+.5)*(o/50),s.opacity=Math.random()*.3+.1,s.wobble=Math.random()*10,s.shape=e.bubble;else if(a===`confetti`){let t=[`#ff0000`,`#00ff00`,`#0000ff`,`#ffff00`,`#ff00ff`,`#00ffff`];s.size=Math.random()*5+3,s.color=n(t[Math.floor(Math.random()*t.length)]),s.vx=(Math.random()-.5)*(o/20),s.vy=(Math.random()*2+2)*(o/50),s.w=s.size,s.h=s.size*1.5,s.shape=e.rect}else a===`digital`&&(s.size=2,s.color=n(`#00ff41`),s.vx=0,s.vy=(Math.random()*5+5)*(o/50),s.opacity=Math.random()*.5+.3,s.shape=e.rect);return s}start(){this.running||!this.supported||(this.running=!0,this.rafId=requestAnimationFrame(this._loop))}stop(){this.running=!1,this.rafId!=null&&(cancelAnimationFrame(this.rafId),this.rafId=null),this.supported&&this.width&&this.height&&this.gl.clear(this.gl.COLOR_BUFFER_BIT)}_loop(){this.running&&(this._step(),this._draw(),this.rafId=requestAnimationFrame(this._loop))}_step(){let{type:t,speed:n}=this.params,r=this.width,i=this.height,a=this.instanceData,o=this.particles;for(let s=0;s<o.length;s++){let c=o[s];t===`bubbles`&&(c.x+=Math.sin(c.wobble)*(n/100),c.wobble+=.05),c.x+=c.vx,c.y+=c.vy,c.rotation+=c.vRotation,t===`stars`&&(c.opacity+=c.twinkle*c.twinkleDir,(c.opacity>.8||c.opacity<.1)&&(c.twinkleDir*=-1)),c.x<-20&&(c.x=r+20),c.x>r+20&&(c.x=-20),c.y<-20&&(c.y=i+20),c.y>i+20&&(c.y=-20);let l,u,d;c.shape===e.rect?t===`rain`?(l=c.size,u=15,d=.4*c.opacity):t===`digital`?(l=2,u=10,d=c.opacity):(l=c.w,u=c.h,d=c.opacity):(l=c.size*2,u=c.size*2,d=c.opacity);let f=s*9;a[f]=c.x,a[f+1]=c.y,a[f+2]=l,a[f+3]=u,a[f+4]=c.rotation,a[f+5]=c.color[0],a[f+6]=c.color[1],a[f+7]=c.color[2],a[f+8]=d}}_draw(){let e=this.gl,t=this.particles.length;e.clear(e.COLOR_BUFFER_BIT),t!==0&&(e.useProgram(this.program),e.bindVertexArray(this.vao),e.uniform2f(this.loc.resolution,this.width,this.height),e.uniform1i(this.loc.shape,this.particles[0].shape),e.bindBuffer(e.ARRAY_BUFFER,this.instanceBuf),e.bufferData(e.ARRAY_BUFFER,this.instanceData,e.DYNAMIC_DRAW),e.drawArraysInstanced(e.TRIANGLE_STRIP,0,4,t),e.bindVertexArray(null))}destroy(){this.stop();let e=this.gl;e&&(this.quadBuf&&e.deleteBuffer(this.quadBuf),this.instanceBuf&&e.deleteBuffer(this.instanceBuf),this.vao&&e.deleteVertexArray(this.vao),this.program&&e.deleteProgram(this.program),this.particles=[],this.instanceData=null)}};let o=null;self.onmessage=e=>{let t=e.data||{};switch(t.cmd){case`init`:o=new a(t.canvas),o.supported||self.postMessage({event:`unsupported`});break;case`configure`:o?.configure({type:t.type,intensity:t.intensity,speed:t.speed});break;case`resize`:o?.resize(t.width,t.height);break;case`start`:o?.start();break;case`stop`:o?.stop();break;case`destroy`:o?.destroy(),o=null;break;default:break}}})();