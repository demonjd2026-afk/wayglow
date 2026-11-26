/**
 * Fog and lantern heat behind everything: one fragment shader, no libraries.
 * Returns null when WebGL is missing; the CSS gradient on <body> shows instead.
 */
export type Backdrop = {
  /** Place a warm light. x and y run 0..1 from the top-left of the viewport. */
  light(slot: 0 | 1, x: number, y: number, strength: number): void
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'
const FRAG = `precision mediump float;
uniform vec2 r;uniform float t;uniform vec3 a;uniform vec3 b;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,k=.5;for(int i=0;i<4;i++){v+=k*n(p);p=p*2.03+vec2(1.7,9.2);k*=.5;}return v;}
vec3 heat(vec2 p,vec3 l,float asp,float f){vec2 c=vec2(l.x*asp,l.y);float d=distance(p,c);
float g=l.z*exp(-d*d*7.)*(.55+.45*f);return mix(vec3(1.,.34,.16),vec3(1.,.66,.26),smoothstep(0.,.3,d))*g;}
void main(){vec2 uv=gl_FragCoord.xy/r;uv.y=1.-uv.y;float asp=r.x/r.y;vec2 p=vec2(uv.x*asp,uv.y);
float f=fbm(p*2.1+vec2(t*.018,-t*.03));float g=fbm(p*4.2+vec2(-t*.026,t*.014)+f);
vec3 c=mix(vec3(.022,.034,.086),vec3(.085,.11,.26),smoothstep(.25,.85,f));
c=mix(c,vec3(.04,.2,.21),smoothstep(.55,.95,g)*.32);
c+=heat(p,a,asp,g)*.5+heat(p,b,asp,g)*.38;
c*=1.-.62*smoothstep(.25,.95,distance(uv,vec2(.5,.52)));
c+=(h(gl_FragCoord.xy+fract(t)*91.)-.5)*.03;
gl_FragColor=vec4(c,1.);}`

export function backdrop(
  canvas: HTMLCanvasElement,
  calm: boolean,
): Backdrop | null {
  const gl = canvas.getContext('webgl', {
    antialias: false,
    alpha: false,
    powerPreference: 'low-power',
  })
  if (!gl) return null
  const compile = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
  }
  const vs = compile(gl.VERTEX_SHADER, VERT)
  const fs = compile(gl.FRAGMENT_SHADER, FRAG)
  const prog = gl.createProgram()
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  )
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const u = {
    r: gl.getUniformLocation(prog, 'r'),
    t: gl.getUniformLocation(prog, 't'),
    a: gl.getUniformLocation(prog, 'a'),
    b: gl.getUniformLocation(prog, 'b'),
  }
  const lights: [number, number, number][] = [
    [0.5, 0.85, 0],
    [0.5, 0.15, 0],
  ]
  // Fog is soft, so half resolution is invisible and keeps phones cool.
  const fit = (): void => {
    const w = Math.max(1, Math.round(canvas.clientWidth * 0.5))
    const h = Math.max(1, Math.round(canvas.clientHeight * 0.5))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      gl.viewport(0, 0, w, h)
    }
  }
  let last = 0
  const frame = (now: number): void => {
    if (!calm) requestAnimationFrame(frame)
    if (now - last < 33 || document.hidden) return
    last = now
    fit()
    gl.uniform2f(u.r, canvas.width, canvas.height)
    gl.uniform1f(u.t, calm ? 12 : now / 1000)
    gl.uniform3f(u.a, ...(lights[0] as [number, number, number]))
    gl.uniform3f(u.b, ...(lights[1] as [number, number, number]))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  requestAnimationFrame(frame)
  return {
    light(slot, x, y, strength) {
      lights[slot] = [x, y, strength]
      if (calm) requestAnimationFrame(t => frame(t + 1000))
    },
  }
}
