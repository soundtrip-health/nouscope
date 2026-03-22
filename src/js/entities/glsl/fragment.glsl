precision mediump float;

varying float vDistance;

uniform vec3 startColor;
uniform vec3 endColor;
uniform float heartPulse;
uniform float hueShift;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float circle(in vec2 _st,in float _radius){
  vec2 dist=_st-vec2(.5);
  return 1.-smoothstep(_radius-(_radius*.01),
  _radius+(_radius*.01),
  dot(dist,dist)*4.);
}

void main(){
  float alpha=1.;
  vec2 uv = vec2(gl_PointCoord.x,1.-gl_PointCoord.y);
  vec3 circ = vec3(circle(uv,1.));

  vec3 color = mix(startColor,endColor,vDistance);

  // EEG-driven hue shift — rotates the color palette based on brain state
  vec3 hsv = rgb2hsv(color);
  hsv.x = fract(hsv.x + hueShift);
  color = hsv2rgb(hsv);

  // Heartbeat pulse: warm reddish flush that fades in with each beat
  // The cube-shaped oscillator gives a sharp systolic spike and slow diastolic decay
  vec3 pulseWarm = vec3(0.45, 0.05, 0.08);
  color = mix(color, color + pulseWarm, heartPulse * 0.35);

  gl_FragColor=vec4(color,circ.r * vDistance);
}