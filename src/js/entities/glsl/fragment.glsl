precision mediump float;

varying float vDistance;

uniform vec3 startColor;
uniform vec3 endColor;
uniform float heartPulse;

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

  // Heartbeat pulse: warm reddish flush that fades in with each beat
  // The cube-shaped oscillator gives a sharp systolic spike and slow diastolic decay
  vec3 pulseWarm = vec3(0.45, 0.05, 0.08);
  color = mix(color, color + pulseWarm, heartPulse * 0.35);

  gl_FragColor=vec4(color,circ.r * vDistance);
}