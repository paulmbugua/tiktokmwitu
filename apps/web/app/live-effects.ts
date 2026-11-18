import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';

export const cameraLooks = [
  { id: 'off', name: 'Original', description: 'Unfiltered camera', values: [0, 0, 0, 0] },
  { id: 'soft', name: 'Soft Focus', description: 'Softens fine detail', values: [.07, .015, .02, .6] },
  { id: 'daylight', name: 'Window Light', description: 'Lifts shadows', values: [.21, .018, -.04, .21] },
  { id: 'golden', name: 'Golden Hour', description: 'Warm, soft light', values: [.09, .12, .08, .24] },
  { id: 'studio', name: 'Studio', description: 'Adds contrast and color', values: [.04, -.016, .19, .27] },
] as const;

export type CameraLook = (typeof cameraLooks)[number];

const vertexSource = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const fragmentSource = `
precision mediump float;
varying vec2 uv;
uniform sampler2D camera;
uniform vec2 pixel;
uniform vec4 look;
const vec3 weights = vec3(0.2126, 0.7152, 0.0722);

vec4 sampleNear(vec3 center, vec2 delta) {
  vec3 sampleColor = texture2D(camera, uv + delta).rgb;
  vec3 difference = sampleColor - center;
  float blend = 1.0 - smoothstep(0.005, 0.06, dot(difference, difference));
  return vec4(sampleColor * blend, blend);
}

void main() {
  vec3 source = texture2D(camera, uv).rgb;
  vec3 rgb = source;
  if (look.w > 0.01) {
    vec4 average = vec4(source * 2.0, 2.0);
    average += sampleNear(source, vec2(pixel.x, 0.0));
    average += sampleNear(source, -vec2(pixel.x, 0.0));
    average += sampleNear(source, vec2(0.0, pixel.y));
    average += sampleNear(source, -vec2(0.0, pixel.y));
    rgb = mix(source, average.rgb / average.a, look.w);
  }
  rgb += (1.0 - rgb) * rgb * look.x;
  float luma = dot(rgb, weights);
  rgb = mix(vec3(luma), rgb, 1.0 + look.z * 0.68);
  rgb = (rgb - 0.5) * (1.0 + look.z * 0.42) + 0.5;
  rgb += vec3(1.0, 0.19, -0.8) * look.y * (0.3 + 0.7 * luma);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Camera shader unavailable.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new Error('Camera shader unavailable.');
  }
  return shader;
}

export class CameraEffects implements TrackProcessor<Track.Kind.Video> {
  readonly name = 'Mwitu Camera';
  processedTrack?: MediaStreamTrack;
  private cancel?: () => void;
  private release?: () => void;
  private values = new Float32Array(4);

  constructor(preset: CameraLook, strength: number, private readonly onInterrupted: () => void) {
    this.setLook(preset, strength);
  }

  setLook(preset: CameraLook, strength: number) {
    this.values.set(preset.values.map(value => value * Math.min(1, Math.max(0, strength / 100))));
  }

  async init({ track }: VideoProcessorOptions) {
    const canvas = document.createElement('canvas');
    if (typeof canvas.captureStream !== 'function') throw new Error('Camera effects are unavailable in this browser.');
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('Camera effects are unavailable in this browser.');

    const source = document.createElement('video');
    source.muted = true;
    source.playsInline = true;
    source.srcObject = new MediaStream([track]);
    this.release = () => {
      source.pause();
      source.srcObject = null;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };

    try {
      const program = gl.createProgram();
      if (!program) throw new Error('Camera shader unavailable.');
      const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
      const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Camera shader unavailable.');
      gl.useProgram(program);
      const plane = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, plane);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const pixel = gl.getUniformLocation(program, 'pixel');
      const look = gl.getUniformLocation(program, 'look');
      let stopped = false;
      let frame = 0;
      let last = -Infinity;
      const videoFrames = typeof source.requestVideoFrameCallback === 'function';
      const loss = (event: Event) => {
        event.preventDefault();
        if (!stopped) this.onInterrupted();
      };
      canvas.addEventListener('webglcontextlost', loss);
      this.cancel = () => {
        stopped = true;
        if (videoFrames) source.cancelVideoFrameCallback(frame);
        else cancelAnimationFrame(frame);
        canvas.removeEventListener('webglcontextlost', loss);
      };

      const paint = () => {
        const width = source.videoWidth;
        const height = source.videoHeight;
        if (!width || !height || source.readyState < 2) return;
        const ratio = Math.min(1, 960 / Math.max(width, height));
        const outputWidth = Math.max(2, Math.floor(width * ratio / 2) * 2);
        const outputHeight = Math.max(2, Math.floor(height * ratio / 2) * 2);
        if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
          canvas.width = outputWidth;
          canvas.height = outputHeight;
          gl.viewport(0, 0, outputWidth, outputHeight);
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
        gl.uniform2f(pixel, 2.5 / outputWidth, 2.5 / outputHeight);
        gl.uniform4fv(look, this.values);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      const next = () => {
        if (!stopped) frame = videoFrames ? source.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
      };
      const draw = (now: number) => {
        if (stopped) return;
        if (now - last >= 32) {
          try { paint(); } catch { this.onInterrupted(); return; }
          last = now;
        }
        next();
      };
      await source.play();
      paint();
      const processed = canvas.captureStream(30).getVideoTracks()[0];
      if (!processed) throw new Error('Could not start the camera effect.');
      this.processedTrack = processed;
      next();
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  async restart(options: VideoProcessorOptions) {
    await this.destroy();
    await this.init(options);
  }

  async destroy() {
    this.cancel?.();
    this.release?.();
    this.processedTrack?.stop();
    this.cancel = this.release = undefined;
    this.processedTrack = undefined;
  }
}
