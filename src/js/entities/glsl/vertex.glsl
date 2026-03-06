precision mediump float;

/**
 * Vertex shader — simplex noise curl field for particle displacement.
 *
 * Algorithm:
 *   1. For each vertex, evaluate a 2D simplex noise field at three axis-pairs
 *      (xy, xz, yz), using finite differences to estimate the curl (divergence-free
 *      vector field). This ensures particles flow smoothly without clumping.
 *   2. The curl vector is scaled by `amplitude` and added to the base position,
 *      producing a displaced target position.
 *   3. The particle is interpolated between its base position and the target
 *      using a power-of-4 falloff on the displacement distance, keeping particles
 *      near their geometry surface when amplitude is low.
 *   4. An additional z-axis oscillation driven by `offsetGain` adds turbulence.
 *   5. Point size is modulated by displacement distance and depth (perspective).
 *
 * Noise source: Ian McEwan / Ashima Arts simplex noise
 *   https://github.com/ashima/webgl-noise
 *   https://github.com/stegu/webgl-noise
 */

varying float vDistance;

uniform float time;
uniform float offsetSize;
uniform float size;
uniform float offsetGain;
uniform float amplitude;
uniform float frequency;
uniform float maxDistance;


vec3 mod289(vec3 x){
  return x-floor(x*(1./289.))*289.;
}

vec2 mod289(vec2 x){
  return x-floor(x*(1./289.))*289.;
}

vec3 permute(vec3 x){
  return mod289(((x*34.)+1.)*x);
}

// 2D simplex noise — Ian McEwan, Ashima Arts
float noise(vec2 v) {

  const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  // First corner
  vec2 i=floor(v+dot(v,C.yy));
  vec2 x0=v-i+dot(i,C.xx);

  // Other corners
  vec2 i1;
  i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
  vec4 x12=x0.xyxy+C.xxzz;
  x12.xy-=i1;

  // Permutations
  i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))
  +i.x+vec3(0.,i1.x,1.));

  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
  m=m*m;
  m=m*m;

  // Gradients: 41 points uniformly over a line, mapped onto a diamond.
  vec3 x=2.*fract(p*C.www)-1.;
  vec3 h=abs(x)-.5;
  vec3 ox=floor(x+.5);
  vec3 a0=x-ox;

  // Normalise gradients implicitly by scaling m
  m*=1.79284291400159-.85373472095314*(a0*a0+h*h);

  // Compute final noise value at P
  vec3 g;
  g.x=a0.x*x0.x+h.x*x0.y;
  g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.*dot(m,g);
}

// Curl of the 2D noise field — divergence-free flow
vec3 curl(float x,float y,float z) {

  float eps=1.,eps2=2.*eps;
  float n1,n2,a,b;

  // Animate the field by scrolling through noise space over time
  x+=time*.05;
  y+=time*.05;
  z+=time*.05;

  vec3 curl=vec3(0.);

  n1=noise(vec2(x,y+eps));
  n2=noise(vec2(x,y-eps));
  a=(n1-n2)/eps2;

  n1=noise(vec2(x,z+eps));
  n2=noise(vec2(x,z-eps));
  b=(n1-n2)/eps2;

  curl.x=a-b;

  n1=noise(vec2(y,z+eps));
  n2=noise(vec2(y,z-eps));
  a=(n1-n2)/eps2;

  n1=noise(vec2(x+eps,z));
  n2=noise(vec2(x+eps,z));
  b=(n1-n2)/eps2;

  curl.y=a-b;

  n1=noise(vec2(x+eps,y));
  n2=noise(vec2(x-eps,y));
  a=(n1-n2)/eps2;

  n1=noise(vec2(y+eps,z));
  n2=noise(vec2(y-eps,z));
  b=(n1-n2)/eps2;

  curl.z=a-b;

  return curl;
}

void main() {
  vec3 newpos = position;
  // Displace vertex along the curl field, scaled by audio amplitude
  vec3 target = position + (normal*.1) + curl(newpos.x * frequency, newpos.y * frequency, newpos.z * frequency) * amplitude;

  // Normalise displacement distance relative to maxDistance
  float d = length(newpos - target) / maxDistance;
  // Blend toward displaced position using power-of-4 falloff
  newpos = mix(position, target, pow(d, 4.));
  // Extra z-oscillation from mid-frequency turbulence
  newpos.z += sin(time) * (.1 * offsetGain);

  vec4 mvPosition = modelViewMatrix * vec4(newpos, 1.);
  // Perspective-correct point size: larger displacement = larger point
  gl_PointSize = size + (pow(d,3.) * offsetSize) * (1./-mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;

  vDistance = d;
}
