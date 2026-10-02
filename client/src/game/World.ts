import * as THREE from 'three';
import { LEVELS, WORLD_LIMITS, normalizeMovement, type PlayerSnapshot, type RoomSnapshot } from '@dargaze/shared';

type Stage = 'menu' | 'forest' | 'tree' | 'portal' | 'volcano';
type Mode = 'showcase' | 'cinematic' | 'solo' | 'online';
export interface Controls { moveX: number; moveZ: number; jump: boolean; }
export interface InteractionTarget { id: string; label: string; distance: number; }
interface Avatar {
  root: THREE.Group;
  body: THREE.Group;
  label: THREE.Sprite;
  jacket: THREE.MeshStandardMaterial;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  target: THREE.Vector3;
  position: THREE.Vector3;
  name: string;
  slot: number;
  health: number;
  downed: boolean;
  kind: 'human' | 'ai';
  color: string;
  invulnerableUntil: number;
}
interface ParticleCloud { points: THREE.Points; velocities: Float32Array; baseY: number; }
const accents = ['#c35634', '#dfa44e', '#5c89a3'];
const skin = '#bb8062';

function material(color: string | number, roughness = 0.86, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, ...extra });
}
function mesh(geometry: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const result = new THREE.Mesh(geometry, mat); result.position.set(x, y, z); result.castShadow = true; result.receiveShadow = true; return result;
}
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

export class GameWorld {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(49, 1, 0.1, 180);
  readonly renderer: THREE.WebGLRenderer;
  readonly worldRoot = new THREE.Group();
  readonly players = new Map<string, Avatar>();
  readonly collected = new Set<string>();
  private readonly clock = new THREE.Clock();
  private readonly crystalMeshes = new Map<string, THREE.Group>();
  private readonly flickerLights: THREE.PointLight[] = [];
  private readonly particles: ParticleCloud[] = [];
  private readonly pingMarkers: Array<{ group: THREE.Group; expiresAt: number }> = [];
  private stage: Stage = 'menu';
  private mode: Mode = 'showcase';
  private controls: Controls = { moveX: 0, moveZ: 0, jump: false };
  private customNames = ['Milo', 'Ivo', 'Tavi'];
  private customColors = ['#c35634', '#dfa44e', '#5c89a3'];
  private controlledId = 'solo-hero';
  private selfId = 'solo-hero';
  private yaw = 0;
  private pitch = 0.24;
  private velocityY = 0;
  private localHealth = 100;
  private localGateOpen = false;
  private localCheckpoint: { x: number; z: number } = { ...LEVELS.emberCliffs.checkpoint };
  private localInvulnerableUntil = 0;
  private lastLavaDamage = 0;
  private time = 0;
  private cameraLook = new THREE.Vector3(0, 1.5, 0);
  private portalRing: THREE.Mesh | undefined;
  private lavaMaterial: THREE.MeshStandardMaterial | undefined;
  private disposed = false;
  private animationFrame = 0;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.scene.add(this.worldRoot);
    this.resize();
    this.setStage('menu');
    window.addEventListener('resize', this.resize);
    this.animate();
  }

  private resize = (): void => {
    const width = Math.max(1, window.innerWidth); const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  setStage(stage: Stage): void {
    this.stage = stage; this.mode = stage === 'menu' ? 'showcase' : 'cinematic';
    this.rebuild(stage);
  }

  setCustomization(names: string[], colors: string[]): void {
    this.customNames = [0, 1, 2].map((index) => names[index]?.trim().slice(0, 24) || ['Milo', 'Ivo', 'Tavi'][index]!);
    this.customColors = [0, 1, 2].map((index) => /^#[0-9a-f]{6}$/i.test(colors[index] ?? '') ? colors[index]! : accents[index]!);
    for (const [id, avatar] of this.players) {
      const name = avatar.kind === 'ai' ? this.customNames[avatar.slot]! : this.mode === 'solo' && id === this.controlledId ? this.customNames[0]! : avatar.name;
      this.setAvatarName(avatar, name);
      avatar.color = this.customColors[avatar.slot]!; avatar.jacket.color.set(avatar.color);
    }
  }

  startSolo(): void {
    this.stage = 'volcano'; this.mode = 'solo'; this.selfId = this.controlledId = 'solo-hero'; this.localHealth = 100;
    this.localGateOpen = false; this.localCheckpoint = { ...LEVELS.emberCliffs.checkpoint }; this.collected.clear(); this.yaw = 0; this.pitch = 0.22; this.velocityY = 0;
    this.rebuild('volcano');
    this.addAvatar('solo-hero', this.customNames[0]!, 0, this.customColors[0]!, 'human', LEVELS.emberCliffs.start.x, LEVELS.emberCliffs.start.z);
    this.addAvatar('ai-ivo', this.customNames[1]!, 1, this.customColors[1]!, 'ai', -2, LEVELS.emberCliffs.start.z + 1.3);
    this.addAvatar('ai-tavi', this.customNames[2]!, 2, this.customColors[2]!, 'ai', 2, LEVELS.emberCliffs.start.z + 2);
    this.positionShadow();
  }

  startOnline(snapshot: RoomSnapshot, selfId: string): void {
    this.stage = 'volcano'; this.mode = 'online'; this.selfId = this.controlledId = selfId;
    this.localGateOpen = snapshot.gateOpen; this.localCheckpoint = { ...snapshot.checkpoint }; this.collected.clear(); snapshot.crystals.forEach((id) => this.collected.add(id));
    this.yaw = 0; this.pitch = 0.22; this.velocityY = 0;
    this.rebuild('volcano'); this.updateRoomSnapshot(snapshot, selfId);
  }

  returnToMenu(): void {
    this.controls = { moveX: 0, moveZ: 0, jump: false }; this.collected.clear(); this.players.clear();
    this.stage = 'menu'; this.mode = 'showcase'; this.yaw = 0; this.rebuild('menu');
  }

  setControls(controls: Controls): void { this.controls = controls; }
  setCameraDelta(dx: number, dy: number): void {
    if (this.mode !== 'solo' && this.mode !== 'online') return;
    this.yaw -= dx * 0.0026;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.0018, -0.02, 0.65);
  }

  /** World-space, normalized intent for the authoritative server. */
  getServerMovement(): { moveX: number; moveZ: number; jump: boolean } {
    const { moveX, moveZ, jump } = this.controls;
    const forward = -moveZ;
    const movement = normalizeMovement(Math.cos(this.yaw) * moveX + Math.sin(this.yaw) * forward, Math.sin(this.yaw) * moveX - Math.cos(this.yaw) * forward);
    return { moveX: movement.x, moveZ: movement.z, jump };
  }

  getControlledPosition(): { x: number; y: number; z: number } {
    const avatar = this.players.get(this.controlledId);
    return avatar ? { x: avatar.position.x, y: avatar.position.y, z: avatar.position.z } : { x: 0, y: 0, z: 0 };
  }

  getHealth(): number { return this.mode === 'online' ? (this.players.get(this.selfId)?.health ?? 100) : this.localHealth; }
  isGateOpen(): boolean { return this.localGateOpen; }
  getPartyHealth(): Array<{ id: string; name: string; health: number; downed: boolean; kind: 'human' | 'ai' }> {
    return [...this.players.entries()].map(([id, player]) => ({ id, name: player.name, health: player.health, downed: player.downed, kind: player.kind }));
  }

  getNearbyTarget(): InteractionTarget | null {
    const player = this.players.get(this.controlledId); if (!player) return null;
    const candidates: Array<{ id: string; label: string; x: number; z: number }> = [];
    const checkpointAlreadySet = Math.hypot(this.localCheckpoint.x - LEVELS.emberCliffs.checkpointStone.x, this.localCheckpoint.z - LEVELS.emberCliffs.checkpointStone.z) < 0.2;
    if (!checkpointAlreadySet) candidates.push({ id: 'checkpoint', label: 'Attune checkpoint', x: LEVELS.emberCliffs.checkpointStone.x, z: LEVELS.emberCliffs.checkpointStone.z });
    for (const crystal of LEVELS.emberCliffs.crystals) if (!this.collected.has(crystal.id)) candidates.push({ id: crystal.id, label: 'Take Ember Crystal', x: crystal.x, z: crystal.z });
    if (this.collected.size === LEVELS.emberCliffs.crystals.length && !this.localGateOpen) candidates.push({ id: 'altar', label: 'Place crystals on altar', x: LEVELS.emberCliffs.altar.x, z: LEVELS.emberCliffs.altar.z });
    if (this.localGateOpen) candidates.push({ id: 'gate', label: 'Enter the gate', x: LEVELS.emberCliffs.gate.x, z: LEVELS.emberCliffs.gate.z });
    for (const ally of this.players.values()) if (ally.downed && ally.root.uuid !== player.root.uuid) candidates.push({ id: `revive:${ally.slot}`, label: `Revive ${ally.name}`, x: ally.position.x, z: ally.position.z });
    const nearest = candidates.map((candidate) => ({ ...candidate, distance: Math.hypot(candidate.x - player.position.x, candidate.z - player.position.z) })).sort((a, b) => a.distance - b.distance)[0];
    return nearest && nearest.distance <= 2.7 ? { id: nearest.id, label: nearest.label, distance: nearest.distance } : null;
  }

  applyLocalInteraction(targetId: string): { message: string; complete: boolean } {
    if (targetId === 'checkpoint') {
      this.localCheckpoint = { ...LEVELS.emberCliffs.checkpointStone };
      return { message: 'Checkpoint attuned. Your party will return here.', complete: false };
    }
    if (targetId.startsWith('revive:')) {
      const slot = Number(targetId.slice(7)); const ally = [...this.players.values()].find((player) => player.slot === slot);
      if (ally) { ally.downed = false; ally.health = 45; ally.invulnerableUntil = Date.now() + 3000; }
      return { message: ally ? `${ally.name} is back on their feet.` : 'Your friend is too far away.', complete: false };
    }
    const crystal = LEVELS.emberCliffs.crystals.find((item) => item.id === targetId);
    if (crystal) {
      if (this.collected.has(targetId)) return { message: 'That crystal is already safe.', complete: false };
      this.collected.add(targetId); this.syncCrystalMeshes();
      return { message: `Ember Crystal found · ${this.collected.size}/3`, complete: false };
    }
    if (targetId === 'altar') {
      if (this.collected.size < 3) return { message: 'The altar needs all three Ember Crystals.', complete: false };
      this.localGateOpen = true; this.animateGateOpen();
      return { message: 'The altar wakes. The gate is open.', complete: false };
    }
    if (targetId === 'gate' && this.localGateOpen) return { message: 'Level 2 Unlocked', complete: true };
    return { message: 'Nothing answers.', complete: false };
  }

  updateRoomSnapshot(snapshot: RoomSnapshot, selfId = this.selfId): void {
    this.selfId = selfId;
    this.localGateOpen = snapshot.gateOpen; this.localCheckpoint = { ...snapshot.checkpoint };
    this.collected.clear(); snapshot.crystals.forEach((id) => this.collected.add(id));
    const ids = new Set(snapshot.players.map((player) => player.id));
    for (const id of this.players.keys()) if (!ids.has(id)) { const avatar = this.players.get(id)!; this.worldRoot.remove(avatar.root); this.players.delete(id); }
    for (const player of snapshot.players) {
      const displayName = player.kind === 'ai' ? this.customNames[player.slot] ?? player.name : player.name;
      const displayColor = this.customColors[player.slot] ?? accents[player.slot] ?? accents[0]!;
      let avatar = this.players.get(player.id);
      if (!avatar) avatar = this.addAvatar(player.id, displayName, player.slot, displayColor, player.kind, player.x, player.z);
      this.setAvatarName(avatar, displayName); avatar.kind = player.kind; avatar.health = player.health; avatar.downed = player.downed; avatar.invulnerableUntil = player.invulnerableUntil;
      avatar.color = displayColor; avatar.jacket.color.set(displayColor);
      avatar.target.set(player.x, player.y, player.z);
      if (player.id === selfId) this.controlledId = player.id;
    }
    this.syncCrystalMeshes();
    if (snapshot.gateOpen) this.animateGateOpen();
  }

  markCrystalCollected(targetId: string): void { this.collected.add(targetId); this.syncCrystalMeshes(); }

  showPing(x: number, z: number, kind: 'look' | 'danger' | 'objective'): void {
    const color = kind === 'danger' ? '#ef5946' : kind === 'objective' ? '#efad68' : '#79b5c4';
    const group = new THREE.Group(); group.position.set(x, 0.14, z);
    const ringMaterial = material(color, 0.28, { emissive: color, emissiveIntensity: 2.2, transparent: true, opacity: 0.9 });
    const ring = mesh(new THREE.TorusGeometry(0.58, 0.055, 6, 28), ringMaterial, 0, 0, 0); ring.rotation.x = Math.PI / 2; group.add(ring);
    const marker = this.makeTextSprite(kind === 'danger' ? '!' : kind === 'objective' ? '✦' : '⌁', color, 140, 140);
    marker.position.set(0, 1.45, 0); marker.scale.set(0.65, 0.65, 1); group.add(marker);
    this.worldRoot.add(group); this.pingMarkers.push({ group, expiresAt: Date.now() + 6500 });
  }

  private rebuild(stage: Stage): void {
    this.clearWorld(); this.players.clear(); this.crystalMeshes.clear(); this.flickerLights.length = 0; this.particles.length = 0; this.pingMarkers.length = 0;
    this.portalRing = undefined; this.lavaMaterial = undefined; this.velocityY = 0;
    this.scene.fog = null;
    if (stage === 'forest' || stage === 'tree' || stage === 'portal') this.buildForest(stage);
    else this.buildVolcano(stage === 'menu');
    if (this.mode === 'showcase') {
      this.addAvatar('show-milo', 'Milo', 0, accents[0]!, 'human', -1.2, 3.5);
      this.addAvatar('show-ivo', 'Ivo', 1, accents[1]!, 'human', 0.1, 3.7);
      this.addAvatar('show-tavi', 'Tavi', 2, accents[2]!, 'human', 1.4, 4);
      this.addShadow();
      this.camera.position.set(13.6, 8.7, 15.5); this.camera.lookAt(0, 2.1, -12);
    } else if (this.mode === 'cinematic') {
      this.addAvatar('intro-milo', 'Milo', 0, accents[0]!, 'human', -1.8, -1.1);
      this.addAvatar('intro-ivo', 'Ivo', 1, accents[1]!, 'human', 0, -1.5);
      this.addAvatar('intro-tavi', 'Tavi', 2, accents[2]!, 'human', 1.8, -1.1);
      this.camera.position.set(0, 7.2, 10.5); this.camera.lookAt(0, 1.5, -4.5);
    }
  }

  private clearWorld(): void {
    for (const object of [...this.worldRoot.children]) {
      this.worldRoot.remove(object);
      object.traverse((child) => {
        const drawable = child as THREE.Mesh;
        if (drawable.geometry) drawable.geometry.dispose();
        const mats = Array.isArray(drawable.material) ? drawable.material : drawable.material ? [drawable.material] : [];
        mats.forEach((mat) => { if ('map' in mat && (mat as THREE.Material & { map?: THREE.Texture }).map) (mat as THREE.Material & { map?: THREE.Texture }).map!.dispose(); mat.dispose(); });
      });
    }
  }

  private buildVolcano(isMenu: boolean): void {
    this.scene.background = new THREE.Color('#1a090b');
    this.scene.fog = new THREE.FogExp2('#220f11', 0.014);
    const ambient = new THREE.HemisphereLight('#e27b4f', '#080609', 1.35); this.worldRoot.add(ambient);
    const moon = new THREE.DirectionalLight('#697084', 2.1); moon.position.set(-16, 24, 13); moon.castShadow = true; moon.shadow.mapSize.set(1024, 1024); moon.shadow.camera.left = -34; moon.shadow.camera.right = 34; moon.shadow.camera.top = 34; moon.shadow.camera.bottom = -34; moon.shadow.bias = -0.0008; this.worldRoot.add(moon);
    const lavaLight = new THREE.PointLight('#ff4725', 3.2, 36, 2); lavaLight.position.set(-4, 2.8, -2); this.worldRoot.add(lavaLight);
    const ground = mesh(new THREE.PlaneGeometry(100, 100), material('#171619', 1)); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.12; this.worldRoot.add(ground);
    const random = seeded(4027);
    const floorMat = material('#211e20', 1);
    const base = mesh(new THREE.CylinderGeometry(27, 30, 2, 12), floorMat, 0, -1.2, -7); this.worldRoot.add(base);
    for (let i = 0; i < 15; i++) {
      const angle = (i / 15) * Math.PI * 2; const radius = 23 + random() * 10;
      const height = 10 + random() * 19;
      const mountain = mesh(new THREE.ConeGeometry(5 + random() * 5, height, 5 + Math.floor(random() * 3)), material(i % 2 ? '#241a1d' : '#302021', 1), Math.cos(angle) * radius, height / 2 - 2, -7 + Math.sin(angle) * radius);
      mountain.rotation.y = random() * 1.2; this.worldRoot.add(mountain);
    }
    // Volcanic glass path blocks break up the black-rock floor.
    for (let i = 0; i < 60; i++) {
      const x = (random() - 0.5) * 34; const z = -29 + random() * 43;
      if (Math.abs(x) < 3.2 && z > -21 && z < 12) continue;
      const size = 0.32 + random() * 1.2;
      const rock = mesh(new THREE.DodecahedronGeometry(size, 0), material(random() > 0.5 ? '#302a2b' : '#262326', 1), x, size * 0.4, z);
      rock.rotation.set(random() * 1.1, random() * Math.PI, random() * 0.5); this.worldRoot.add(rock);
    }
    this.addCracks(random);
    this.addLavaRiver(12.5, -9, 34, 2.9);
    this.addLavaRiver(-13.3, -14, 26, 2.2);
    this.addLavaRiver(4.5, -29, 8, 1.5);
    for (let z = 12; z > -24; z -= 4) {
      const stone = mesh(new THREE.BoxGeometry(3.3 + random(), 0.18, 2.3 + random()), material('#343033', 0.99), (random() - 0.5) * 1.5, 0.02, z);
      stone.rotation.y = (random() - 0.5) * 0.17; this.worldRoot.add(stone);
    }
    for (let i = 0; i < 13; i++) {
      const side = i % 2 ? 1 : -1; const x = side * (9 + random() * 8); const z = -25 + random() * 42;
      this.addDeadTree(x, z, 0.7 + random() * 1.2);
      if (i % 3 === 0) this.addBones(x + (random() - 0.5) * 2, z - 1);
    }
    for (const position of [[-6, 3], [7, -2], [-7, -11], [9, -18], [-5, -25]] as Array<[number, number]>) this.addTorch(position[0], position[1]);
    this.addAltarAndGate();
    this.addCrystals();
    this.addShadow();
    this.addEmbers(isMenu ? 340 : 240);
    this.addFallingAsh(160);
  }

  private addCracks(random: () => number): void {
    const points: number[] = [];
    for (let i = 0; i < 180; i++) {
      let x = (random() - 0.5) * 35; let z = -30 + random() * 45;
      const count = 2 + Math.floor(random() * 3);
      for (let j = 0; j < count; j++) {
        const nx = x + (random() - 0.5) * 1.3; const nz = z + (random() - 0.5) * 1.3;
        points.push(x, 0.015, z, nx, 0.015, nz); x = nx; z = nz;
      }
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#080809', transparent: true, opacity: 0.7 })); this.worldRoot.add(lines);
  }

  private addLavaRiver(x: number, z: number, length: number, width: number): void {
    const bed = mesh(new THREE.PlaneGeometry(width + 1.1, length), material('#3a1110', 0.46, { emissive: '#b52c18', emissiveIntensity: 0.72 }), x, 0.035, z);
    bed.rotation.x = -Math.PI / 2; this.worldRoot.add(bed);
    const glowMaterial = material('#ed4b21', 0.32, { emissive: '#ff3b19', emissiveIntensity: 2.6 });
    if (!this.lavaMaterial) this.lavaMaterial = glowMaterial;
    const lava = mesh(new THREE.PlaneGeometry(width, length * 0.99), glowMaterial, x, 0.055, z); lava.rotation.x = -Math.PI / 2; this.worldRoot.add(lava);
    const edgeMat = material('#ff8e34', 0.3, { emissive: '#ff511c', emissiveIntensity: 2.3 });
    for (const edge of [-1, 1]) {
      const lip = mesh(new THREE.BoxGeometry(0.16, 0.1, length), edgeMat, x + edge * width / 2, 0.12, z); this.worldRoot.add(lip);
    }
    const light = new THREE.PointLight('#ff441e', 4.5, 14, 2); light.position.set(x, 1.5, z); this.worldRoot.add(light); this.flickerLights.push(light);
  }

  private addDeadTree(x: number, z: number, scale: number): void {
    const group = new THREE.Group(); group.position.set(x, 0, z); group.scale.setScalar(scale);
    const bark = material('#241c1d', 1);
    const trunk = mesh(new THREE.CylinderGeometry(0.12, 0.48, 5.7, 6), bark, 0, 2.6, 0); trunk.rotation.z = -0.11; group.add(trunk);
    for (let i = 0; i < 5; i++) {
      const height = 1.5 + (i % 3) * 0.35; const branch = mesh(new THREE.CylinderGeometry(0.04, 0.17, height, 5), bark, i % 2 ? -0.65 : 0.6, 3.1 + i * 0.34, 0);
      branch.rotation.z = i % 2 ? -0.82 : 0.82; branch.rotation.x = (i - 2) * 0.13; group.add(branch);
    }
    this.worldRoot.add(group);
  }

  private addBones(x: number, z: number): void {
    const group = new THREE.Group(); group.position.set(x, 0.28, z);
    const bone = material('#96877a', 0.85);
    for (let i = 0; i < 5; i++) {
      const shaft = mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.05, 6), bone, (i - 2) * 0.22, i % 2 ? 0.05 : 0, (i % 2) * 0.3); shaft.rotation.z = (i - 2) * 0.13; group.add(shaft);
      for (const end of [-1, 1]) group.add(mesh(new THREE.SphereGeometry(0.11, 5, 4), bone, shaft.position.x + end * 0.5, shaft.position.y, shaft.position.z));
    }
    this.worldRoot.add(group);
  }

  private addTorch(x: number, z: number): void {
    const group = new THREE.Group(); group.position.set(x, 0, z);
    const iron = material('#342a28', 0.8, { metalness: 0.35 });
    group.add(mesh(new THREE.CylinderGeometry(0.09, 0.13, 1.3, 7), iron, 0, 0.65, 0));
    group.add(mesh(new THREE.CylinderGeometry(0.22, 0.12, 0.18, 7), material('#564035'), 0, 1.22, 0));
    const flame = mesh(new THREE.SphereGeometry(0.16, 8, 7), material('#ff7b2d', 0.2, { emissive: '#ff3e15', emissiveIntensity: 3 }), 0, 1.53, 0); flame.scale.set(0.75, 1.4, 0.75); group.add(flame);
    const light = new THREE.PointLight('#f9652d', 3, 10, 2); light.position.set(0, 1.8, 0); group.add(light); this.flickerLights.push(light);
    this.worldRoot.add(group);
  }

  private addAltarAndGate(): void {
    const checkpoint = new THREE.Group(); checkpoint.position.set(LEVELS.emberCliffs.checkpointStone.x, 0, LEVELS.emberCliffs.checkpointStone.z);
    checkpoint.add(mesh(new THREE.CylinderGeometry(0.95, 1.15, 0.28, 8), material('#393235'), 0, 0.14, 0));
    checkpoint.add(mesh(new THREE.BoxGeometry(0.8, 2.2, 0.55), material('#514044'), 0, 1.25, 0));
    checkpoint.add(mesh(new THREE.TorusGeometry(0.72, 0.045, 5, 28), material('#e18b4e', 0.3, { emissive: '#e74622', emissiveIntensity: 1.8 }), 0, 0.32, 0));
    const checkpointLight = new THREE.PointLight('#ff7541', 1.5, 5, 2); checkpointLight.position.set(0, 1.4, 0.7); checkpoint.add(checkpointLight); this.flickerLights.push(checkpointLight);
    this.worldRoot.add(checkpoint);
    const altar = new THREE.Group(); altar.position.set(LEVELS.emberCliffs.altar.x, 0, LEVELS.emberCliffs.altar.z);
    const stone = material('#504244', 0.93, { metalness: 0.08 });
    altar.add(mesh(new THREE.BoxGeometry(5.2, 0.5, 4.2), stone, 0, 0.25, 0));
    altar.add(mesh(new THREE.BoxGeometry(4.2, 0.52, 3.2), material('#383033'), 0, 0.72, 0));
    altar.add(mesh(new THREE.CylinderGeometry(1.35, 1.8, 0.72, 8), stone, 0, 1.34, 0));
    altar.add(mesh(new THREE.CylinderGeometry(1.05, 1.15, 0.18, 8), material('#70412f', 0.65, { emissive: '#7d280f', emissiveIntensity: 0.5 }), 0, 1.8, 0));
    for (let i = 0; i < 3; i++) {
      const rune = mesh(new THREE.BoxGeometry(0.16, 0.035, 1.1), material('#ed6831', 0.3, { emissive: '#ff481b', emissiveIntensity: 1.8 }), -0.55 + i * 0.55, 1.91, 0);
      altar.add(rune);
    }
    this.worldRoot.add(altar);
    const gate = new THREE.Group(); gate.position.set(LEVELS.emberCliffs.gate.x, 0, LEVELS.emberCliffs.gate.z);
    const basalt = material('#343034', 0.95, { metalness: 0.16 });
    gate.add(mesh(new THREE.BoxGeometry(1.2, 7, 1.3), basalt, -3, 3.5, 0));
    gate.add(mesh(new THREE.BoxGeometry(1.2, 7, 1.3), basalt, 3, 3.5, 0));
    gate.add(mesh(new THREE.BoxGeometry(7.2, 1.2, 1.5), basalt, 0, 7.1, 0));
    for (let side of [-1, 1]) for (let y = 1.1; y < 6.8; y += 1.3) gate.add(mesh(new THREE.SphereGeometry(0.12, 7, 6), material('#e2542b', 0.3, { emissive: '#ff321b', emissiveIntensity: 2 }), side * 3, y, 0.72));
    const portal = mesh(new THREE.PlaneGeometry(5.4, 5.9), material('#290e15', 0.24, { color: '#46131d', emissive: '#b92332', emissiveIntensity: 1.2, transparent: true, opacity: 0.82 }), 0, 3.4, 0.12);
    gate.add(portal); gate.userData.portal = portal; gate.userData.gatePortal = portal;
    const ring = mesh(new THREE.TorusGeometry(2.55, 0.11, 8, 40), material('#ff5125', 0.3, { emissive: '#ff351b', emissiveIntensity: 2.3 }), 0, 3.45, 0.25);
    gate.add(ring); this.portalRing = ring;
    const gateLight = new THREE.PointLight('#ff3b35', 1.5, 12, 2); gateLight.position.set(0, 3, 1.8); gate.add(gateLight); this.flickerLights.push(gateLight);
    this.worldRoot.add(gate);
  }

  private addCrystals(): void {
    for (const crystal of LEVELS.emberCliffs.crystals) {
      const group = new THREE.Group(); group.position.set(crystal.x, 0, crystal.z);
      group.add(mesh(new THREE.CylinderGeometry(0.68, 0.87, 0.35, 7), material('#393237'), 0, 0.18, 0));
      group.add(mesh(new THREE.CylinderGeometry(0.4, 0.58, 0.26, 7), material('#634435'), 0, 0.47, 0));
      const crystalMesh = mesh(new THREE.OctahedronGeometry(0.62, 0), material('#ff7935', 0.25, { emissive: '#ff3e16', emissiveIntensity: 2.4, metalness: 0.1 }), 0, 1.3, 0);
      crystalMesh.scale.set(0.7, 1.2, 0.7); group.add(crystalMesh);
      const glow = new THREE.PointLight('#ff682e', 1.8, 5, 2); glow.position.set(0, 1.3, 0); group.add(glow);
      group.userData.crystalId = crystal.id; group.userData.crystalMesh = crystalMesh;
      this.crystalMeshes.set(crystal.id, group); this.worldRoot.add(group);
    }
  }

  private addShadow(): void {
    const group = new THREE.Group(); group.position.set(0, 0, -26.5);
    const cloakMat = material('#08070b', 0.95, { emissive: '#140b12', emissiveIntensity: 0.22 });
    const robe = mesh(new THREE.ConeGeometry(1.45, 6.5, 8), cloakMat, 0, 3.2, 0); robe.scale.z = 0.56; group.add(robe);
    const head = mesh(new THREE.SphereGeometry(0.67, 10, 9), material('#050508', 0.8), 0, 6.12, 0); head.scale.set(0.72, 1.28, 0.65); group.add(head);
    const eyeMat = material('#f75646', 0.15, { emissive: '#ff1724', emissiveIntensity: 5 });
    for (const side of [-1, 1]) group.add(mesh(new THREE.SphereGeometry(0.1, 8, 6), eyeMat, side * 0.23, 6.15, 0.58));
    const red = new THREE.PointLight('#e12e36', 1.4, 7, 2); red.position.set(0, 5.8, 1); group.add(red);
    group.userData.shadowNpc = true; this.worldRoot.add(group);
  }

  private addEmbers(count: number): void {
    const positions = new Float32Array(count * 3); const velocities = new Float32Array(count);
    const random = seeded(771);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (random() - 0.5) * 42; positions[i * 3 + 1] = random() * 9; positions[i * 3 + 2] = -32 + random() * 48; velocities[i] = 0.5 + random() * 2.1;
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#ff8444', size: 0.12, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.worldRoot.add(points); this.particles.push({ points, velocities, baseY: -0.1 });
  }

  private addFallingAsh(count: number): void {
    const positions = new Float32Array(count * 3); const velocities = new Float32Array(count);
    const random = seeded(9201);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (random() - 0.5) * 46; positions[i * 3 + 1] = random() * 18 + 1; positions[i * 3 + 2] = -30 + random() * 45; velocities[i] = 0.7 + random() * 0.7;
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#d2b8a9', size: 0.045, transparent: true, opacity: 0.45, depthWrite: false }));
    this.worldRoot.add(points); this.particles.push({ points, velocities, baseY: 0.6 });
  }

  private addForestTree(x: number, z: number, scale: number, bare: boolean): void {
    const group = new THREE.Group(); group.position.set(x, 0, z); group.scale.setScalar(scale);
    const trunk = mesh(new THREE.CylinderGeometry(0.18, 0.5, 7.5, 7), material(bare ? '#332320' : '#3b291e'), 0, 3.6, 0); trunk.rotation.z = -0.08; group.add(trunk);
    for (let i = 0; i < 6; i++) {
      const branch = mesh(new THREE.CylinderGeometry(0.04, 0.18, 2 + (i % 3) * 0.5, 5), material('#33231e'), i % 2 ? -0.7 : 0.7, 4 + i * 0.32, 0);
      branch.rotation.z = i % 2 ? -0.75 : 0.75; group.add(branch);
      if (!bare) {
        const leaves = mesh(new THREE.IcosahedronGeometry(1.55, 1), material(i % 2 ? '#26382c' : '#304534', 1), i % 2 ? -1.05 : 1.05, 5.5 + i * 0.22, 0);
        leaves.scale.set(1, 0.9, 0.85); group.add(leaves);
      }
    }
    if (!bare) {
      group.add(mesh(new THREE.IcosahedronGeometry(2.1, 1), material('#293b2d'), 0, 7.3, 0));
    }
    this.worldRoot.add(group);
  }

  private addForest(stage: Stage): void {
    this.scene.background = new THREE.Color('#0c1110'); this.scene.fog = new THREE.FogExp2('#17221a', 0.026);
    this.worldRoot.add(new THREE.HemisphereLight('#a9b4a0', '#14120f', 1.5));
    const moon = new THREE.DirectionalLight('#c6b49d', 2.2); moon.position.set(-6, 16, 10); moon.castShadow = true; this.worldRoot.add(moon);
    const floor = mesh(new THREE.PlaneGeometry(80, 80), material('#18201a', 1)); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.15; this.worldRoot.add(floor);
    const random = seeded(8921);
    for (let i = 0; i < 36; i++) {
      const x = (random() - 0.5) * 42; const z = -24 + random() * 34;
      if (Math.abs(x) < 5 && z < 3 && z > -13) continue;
      this.addForestTree(x, z, 0.75 + random() * 1.2, false);
    }
    // The leafless giant is the one landmark seen in the prologue.
    this.addForestTree(0, -7, 1.65, true);
    const trunkRune = this.makeTextSprite('ᚱ   ◉   ✦', '#e7a75d', 512, 128); trunkRune.position.set(0, 4.8, -5.7); trunkRune.scale.set(4.7, 1.1, 1); this.worldRoot.add(trunkRune);
    const pathMat = material('#3b3127', 1);
    for (let i = 0; i < 7; i++) {
      const stone = mesh(new THREE.DodecahedronGeometry(1.1, 0), pathMat, (random() - 0.5) * 3, 0, 7 - i * 2.3); stone.scale.set(1.2, 0.25, 1.35); this.worldRoot.add(stone);
    }
    const fireflies = new THREE.PointLight('#b3aa73', 1.2, 18, 2); fireflies.position.set(-7, 3, -3); this.worldRoot.add(fireflies);
    if (stage === 'portal') {
      const ring = mesh(new THREE.TorusGeometry(2.3, 0.15, 10, 48), material('#b24e2f', 0.25, { emissive: '#fb5428', emissiveIntensity: 2.4 }), 0, 3.1, -5.3);
      this.portalRing = ring; this.worldRoot.add(ring);
      const plane = mesh(new THREE.PlaneGeometry(4.2, 5.7), material('#401525', 0.25, { emissive: '#a41448', emissiveIntensity: 1.9, transparent: true, opacity: 0.72 }), 0, 3.15, -5.18); this.worldRoot.add(plane);
      const light = new THREE.PointLight('#fe5737', 3, 14, 2); light.position.set(0, 3, -3.7); this.worldRoot.add(light);
    }
    if (stage === 'forest') {
      const lantern = new THREE.PointLight('#d58e46', 2.3, 13, 2); lantern.position.set(2, 3, 0); this.worldRoot.add(lantern);
    }
  }

  private buildForest(stage: Stage): void {
    this.addForest(stage);
  }

  private addCrystalsToForest(): void { /* kept as a level-editing seam */ }

  private addAvatar(id: string, name: string, slot: number, color: string, kind: 'human' | 'ai', x: number, z: number): Avatar {
    const root = new THREE.Group(); root.position.set(x, 0, z); root.userData.entityId = id;
    const body = new THREE.Group(); root.add(body);
    const jacket = material(color, 0.8, { roughness: 0.88 });
    const dark = material('#211e22', 0.92); const face = material(skin, 0.88); const hair = material('#2c1d1a', 0.95);
    body.add(mesh(new THREE.CylinderGeometry(0.31, 0.4, 0.76, 8), jacket, 0, 1.03, 0));
    body.add(mesh(new THREE.BoxGeometry(0.12, 0.66, 0.15), material(slot === 0 ? '#d5d0c1' : slot === 1 ? '#ede0bd' : '#c6d6d1'), 0.08, 1.02, 0.355));
    body.add(mesh(new THREE.SphereGeometry(0.31, 12, 10), face, 0, 1.73, 0.02));
    const hairCap = mesh(new THREE.SphereGeometry(0.315, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, 0, 1.86, 0.015); body.add(hairCap);
    const eyeMat = material('#151316', 0.3); body.add(mesh(new THREE.SphereGeometry(0.035, 6, 5), eyeMat, -0.105, 1.73, 0.29)); body.add(mesh(new THREE.SphereGeometry(0.035, 6, 5), eyeMat, 0.105, 1.73, 0.29));
    body.add(mesh(new THREE.TorusGeometry(0.28, 0.055, 5, 12), material(color, 0.75), 0, 1.42, 0.03));
    const leftLeg = new THREE.Group(); leftLeg.position.set(-0.15, 0.67, 0); body.add(leftLeg);
    const rightLeg = new THREE.Group(); rightLeg.position.set(0.15, 0.67, 0); body.add(rightLeg);
    for (const leg of [leftLeg, rightLeg]) {
      leg.add(mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.58, 7), dark, 0, -0.25, 0));
      leg.add(mesh(new THREE.BoxGeometry(0.22, 0.14, 0.34), material('#171519'), 0, -0.54, 0.08));
    }
    const leftArm = new THREE.Group(); leftArm.position.set(-0.39, 1.28, 0); body.add(leftArm);
    const rightArm = new THREE.Group(); rightArm.position.set(0.39, 1.28, 0); body.add(rightArm);
    for (const arm of [leftArm, rightArm]) {
      arm.add(mesh(new THREE.CylinderGeometry(0.105, 0.13, 0.56, 7), jacket, 0, -0.25, 0));
      arm.add(mesh(new THREE.SphereGeometry(0.105, 7, 6), face, 0, -0.55, 0.01));
    }
    const label = this.makeTextSprite(name, kind === 'human' ? '#f0dfcc' : '#cab99f', 360, 96);
    label.position.set(0, 2.55, 0); label.scale.set(2.1, 0.56, 1); root.add(label);
    const avatar: Avatar = {
      root, body, label, jacket, leftLeg, rightLeg, leftArm, rightArm, target: new THREE.Vector3(x, 0, z), position: new THREE.Vector3(x, 0, z),
      name, slot, health: 100, downed: false, kind, color, invulnerableUntil: 0,
    };
    root.userData.avatar = avatar; this.players.set(id, avatar); this.worldRoot.add(root); return avatar;
  }

  private makeTextSprite(text: string, color: string, width: number, height: number): THREE.Sprite {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, width, height); context.font = `700 ${Math.round(height * 0.47)}px Georgia, serif`;
    context.textAlign = 'center'; context.textBaseline = 'middle'; context.shadowColor = '#050304'; context.shadowBlur = 12;
    context.fillStyle = color; context.fillText(text, width / 2, height / 2);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: true }));
    return sprite;
  }

  private setAvatarName(avatar: Avatar, name: string): void {
    if (avatar.name === name) return;
    avatar.name = name;
    const texture = avatar.label.material.map;
    if (texture) texture.dispose();
    const replacement = this.makeTextSprite(name, avatar.kind === 'human' ? '#f0dfcc' : '#cab99f', 360, 96);
    replacement.position.set(0, 2.55, 0); replacement.scale.set(2.1, 0.56, 1);
    avatar.root.remove(avatar.label); avatar.root.add(replacement); avatar.label = replacement;
  }

  private syncCrystalMeshes(): void {
    for (const [id, group] of this.crystalMeshes) group.visible = !this.collected.has(id);
  }

  private animateGateOpen(): void {
    const gate = this.worldRoot.children.find((child) => child.userData.gatePortal) as THREE.Group | undefined;
    if (gate) {
      const portal = gate.userData.gatePortal as THREE.Mesh | undefined;
      if (portal) { const mat = portal.material as THREE.MeshStandardMaterial; mat.emissive.set('#bf2d39'); mat.emissiveIntensity = 2.3; mat.opacity = 1; }
    }
  }

  private positionShadow(): void { /* the shadow is positioned by its world prop */ }

  private animate = (): void => {
    if (this.disposed) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05); this.time += dt;
    this.update(dt); this.renderer.render(this.scene, this.camera);
  };

  private update(dt: number): void {
    for (const cloud of this.particles) {
      const position = cloud.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < cloud.velocities.length; i++) {
        const y = position.getY(i) + cloud.velocities[i]! * dt;
        position.setY(i, y > (cloud.baseY + 18) ? cloud.baseY : y);
        position.setX(i, position.getX(i) + Math.sin(this.time * 0.5 + i) * dt * 0.12);
      }
      position.needsUpdate = true;
    }
    this.flickerLights.forEach((light, index) => { light.intensity = 1.7 + Math.sin(this.time * (6.4 + index) + index) * 0.55 + Math.sin(this.time * 12 + index) * 0.15; });
    for (let i = this.pingMarkers.length - 1; i >= 0; i--) {
      const marker = this.pingMarkers[i]!; const remaining = marker.expiresAt - Date.now();
      if (remaining <= 0) {
        this.worldRoot.remove(marker.group);
        marker.group.traverse((child) => {
          const drawable = child as THREE.Mesh; drawable.geometry?.dispose();
          const mats = Array.isArray(drawable.material) ? drawable.material : drawable.material ? [drawable.material] : [];
          mats.forEach((mat) => { if ('map' in mat && (mat as THREE.Material & { map?: THREE.Texture }).map) (mat as THREE.Material & { map?: THREE.Texture }).map!.dispose(); mat.dispose(); });
        });
        this.pingMarkers.splice(i, 1);
      } else marker.group.scale.setScalar(1 + Math.sin(this.time * 3) * 0.05);
    }
    if (this.lavaMaterial) this.lavaMaterial.emissiveIntensity = 2.25 + Math.sin(this.time * 1.7) * 0.25;
    if (this.portalRing) { this.portalRing.rotation.z += dt * (this.stage === 'portal' ? 0.5 : 0.1); this.portalRing.scale.setScalar(1 + Math.sin(this.time * 2.2) * 0.025); }
    for (const [id, group] of this.crystalMeshes) {
      if (!group.visible) continue;
      const crystal = group.userData.crystalMesh as THREE.Mesh | undefined;
      if (crystal) { crystal.rotation.y += dt * 0.9; crystal.position.y = 1.3 + Math.sin(this.time * 2.4 + id.charCodeAt(id.length - 1)) * 0.12; }
    }

    if (this.mode === 'solo') this.updateSolo(dt);
    if (this.mode === 'online') this.updateOnline(dt);
    if (this.mode === 'showcase') {
      const hero = this.players.get('show-milo'); if (hero) hero.root.rotation.y = Math.sin(this.time * 0.2) * 0.12;
      this.camera.position.x = 13.6 + Math.sin(this.time * 0.055) * 1.2; this.camera.lookAt(0, 2.1, -12);
    }
    if (this.mode === 'cinematic') {
      const actors = [...this.players.values()];
      actors.forEach((actor, index) => { actor.root.rotation.y = Math.sin(this.time * 0.6 + index) * 0.1; });
      if (this.stage === 'portal') this.camera.lookAt(0, 2.6, -5.2);
      else this.camera.lookAt(0, 1.7, -5.3);
    }
  }

  private updateSolo(dt: number): void {
    const hero = this.players.get(this.controlledId); if (!hero) return;
    const movement = this.getServerMovement();
    const speed = 5.2;
    hero.position.x = THREE.MathUtils.clamp(hero.position.x + movement.moveX * speed * dt, WORLD_LIMITS.minX, WORLD_LIMITS.maxX);
    hero.position.z = THREE.MathUtils.clamp(hero.position.z + movement.moveZ * speed * dt, WORLD_LIMITS.minZ, WORLD_LIMITS.maxZ);
    if (movement.jump && hero.position.y <= 0.001 && this.velocityY <= 0) this.velocityY = 6.5;
    this.velocityY -= 17 * dt; hero.position.y += this.velocityY * dt;
    if (hero.position.y < 0) { hero.position.y = 0; this.velocityY = 0; }
    const now = Date.now();
    if (Math.abs(hero.position.x - 12.5) < 1.25 && hero.position.z > -24 && hero.position.z < 7 && hero.position.y < 0.5 && now > this.localInvulnerableUntil && now - this.lastLavaDamage > 500) {
      this.lastLavaDamage = now; this.localHealth = Math.max(0, this.localHealth - 14); hero.health = this.localHealth;
      if (this.localHealth <= 0) {
        this.localHealth = 35; hero.health = 35; hero.position.set(this.localCheckpoint.x, 0, this.localCheckpoint.z); this.localInvulnerableUntil = now + 2800;
      }
    }
    hero.target.copy(hero.position);
    // The two AI friends trail without blocking the hero or stepping into the river.
    for (const friend of [...this.players.values()].filter((item) => item.kind === 'ai')) {
      const side = friend.slot === 1 ? -2.0 : 2.0;
      const targetX = hero.position.x + side; const targetZ = hero.position.z + 1.3;
      const dx = targetX - friend.position.x; const dz = targetZ - friend.position.z; const distance = Math.hypot(dx, dz);
      if (distance > 2.3) {
        const dir = normalizeMovement(dx, dz);
        const nextX = friend.position.x + dir.x * (distance > 9 ? 9 : 4.6) * dt;
        const nextZ = friend.position.z + dir.z * (distance > 9 ? 9 : 4.6) * dt;
        // They steer to the safe path instead of camping on the lava seams.
        if (!(Math.abs(nextX - 12.5) < 1.7 && nextZ > -24 && nextZ < 7)) { friend.position.x = nextX; friend.position.z = nextZ; }
      }
      friend.target.copy(friend.position);
    }
    if (!this.localGateOpen && this.collected.size === LEVELS.emberCliffs.crystals.length && Math.hypot(hero.position.x - LEVELS.emberCliffs.altar.x, hero.position.z - LEVELS.emberCliffs.altar.z) < 3.2) {
      const friendAtAltar = [...this.players.values()].some((friend) => friend.kind === 'ai' && Math.hypot(friend.position.x - LEVELS.emberCliffs.altar.x, friend.position.z - LEVELS.emberCliffs.altar.z) < 3.4);
      if (friendAtAltar) { this.localGateOpen = true; this.animateGateOpen(); } // companions help place the shared crystals.
    }
    this.updateAvatars(dt, movement.moveX !== 0 || movement.moveZ !== 0);
    this.updateCamera(hero.position, dt);
  }

  private updateOnline(dt: number): void {
    const movement = this.getServerMovement();
    const hero = this.players.get(this.selfId);
    if (hero) {
      // Prediction is visual only; authoritative snapshots reconcile the target state.
      const dx = movement.moveX * 5.2 * dt; const dz = movement.moveZ * 5.2 * dt;
      hero.position.x += dx; hero.position.z += dz;
      if (movement.jump && hero.position.y <= 0.01) hero.position.y = Math.max(hero.position.y, 0.06);
      this.updateCamera(hero.position, dt);
    }
    this.updateAvatars(dt, movement.moveX !== 0 || movement.moveZ !== 0);
  }

  private updateAvatars(dt: number, moving: boolean): void {
    for (const avatar of this.players.values()) {
      if (this.mode === 'online') {
        const alpha = 1 - Math.exp(-Math.max(1, 13 * dt));
        avatar.position.lerp(avatar.target, alpha);
      }
      avatar.root.position.set(avatar.position.x, avatar.position.y, avatar.position.z);
      const isMoving = avatar === this.players.get(this.controlledId) ? moving : Math.hypot(avatar.target.x - avatar.position.x, avatar.target.z - avatar.position.z) > 0.04;
      const stride = isMoving ? Math.sin(this.time * 10 + avatar.slot) * 0.48 : Math.sin(this.time * 2.2 + avatar.slot) * 0.035;
      avatar.leftLeg.rotation.x = stride; avatar.rightLeg.rotation.x = -stride;
      avatar.leftArm.rotation.x = -stride * 0.72; avatar.rightArm.rotation.x = stride * 0.72;
      avatar.body.position.y = isMoving ? Math.abs(Math.sin(this.time * 10 + avatar.slot)) * 0.055 : Math.sin(this.time * 1.8 + avatar.slot) * 0.018;
      if (avatar.downed) { avatar.body.rotation.z = -Math.PI / 2; avatar.root.position.y = 0.2; }
      else avatar.body.rotation.z = 0;
      avatar.root.traverse((child) => { if (child instanceof THREE.Sprite && child.material) child.quaternion.copy(this.camera.quaternion); });
    }
  }

  private updateCamera(position: THREE.Vector3, dt: number): void {
    const distance = 8.4; const target = new THREE.Vector3(position.x, position.y + 1.45, position.z);
    const desired = new THREE.Vector3(position.x + Math.sin(this.yaw) * distance, position.y + 3.6 + this.pitch * 4, position.z + Math.cos(this.yaw) * distance);
    this.camera.position.lerp(desired, 1 - Math.exp(-7 * dt)); this.cameraLook.lerp(target, 1 - Math.exp(-9 * dt));
    this.camera.lookAt(this.cameraLook);
  }

  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.animationFrame); window.removeEventListener('resize', this.resize);
    this.clearWorld(); this.renderer.dispose();
  }
}
