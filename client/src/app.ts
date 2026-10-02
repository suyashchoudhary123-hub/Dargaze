import { LEVELS, type RoomSnapshot } from '@dargaze/shared';
import { GameWorld, type InteractionTarget } from './game/World.js';
import { Ambience } from './game/Ambience.js';
import { AuthService, type AuthUser } from './network/AuthService.js';
import { NetworkClient } from './network/NetworkClient.js';

type Screen = 'menu' | 'intro' | 'lobby' | 'game';
type AuthMode = 'login' | 'register' | 'forgot';

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const initials = (value: string): string => value.trim().slice(0, 1).toUpperCase() || 'W';

export class DargazeApp {
  private readonly root: HTMLElement;
  private readonly screenRoot: HTMLElement;
  private readonly hudRoot: HTMLElement;
  private readonly modalRoot: HTMLElement;
  private readonly toastRoot: HTMLElement;
  private readonly reconnectRoot: HTMLElement;
  private readonly chatRoot: HTMLElement;
  private readonly mobileRoot: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly world: GameWorld;
  private readonly ambience = new Ambience();
  private readonly auth = new AuthService();
  private readonly network = new NetworkClient();
  private screen: Screen = 'menu';
  private authMode: AuthMode = 'login';
  private user: AuthUser | null = null;
  private customizationNames = ['Milo', 'Ivo', 'Tavi'];
  private customizationColors = ['#c35634', '#dfa44e', '#5c89a3'];
  private room: RoomSnapshot | null = null;
  private inviteToken = '';
  private pendingJoin: { code?: string; inviteToken?: string } | null = null;
  private currentTarget: InteractionTarget | null = null;
  private keyState = new Set<string>();
  private mobileInput = { x: 0, z: 0, jump: false };
  private joystickPointer: number | null = null;
  private chatOpen = false;
  private chatHistory: Array<{ id: string; name: string; text: string; at: number }> = [];
  private mutedUsers = new Set<string>();
  private inputSequence = 0;
  private networkTick = 0;
  private pingTick = 0;
  private pingMs = 0;
  private uiTick = 0;
  private toastTimer = 0;
  private refreshTimer = 0;
  private netBoundSocket: object | null = null;
  private captchaToken = '';
  private captchaWidgetId: string | null = null;
  private introStep = 0;
  private puzzleOrder = ['flame', 'root', 'moon'];
  private puzzleSolved = false;
  private isMuted = false;
  private pointerDragging = false;
  private lastPointer = { x: 0, y: 0 };
  private emoteText = '';
  private emoteUntil = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="scene-wrap"><canvas id="world-canvas" aria-label="Dargaze volcanic world"></canvas><div class="scene-vignette"></div><div class="scene-grain"></div></div>
      <div id="screen-root"></div><div id="hud-root"></div><div id="modal-root"></div>
      <div id="toast-root" aria-live="polite"></div><div id="reconnect-root"></div>
      <div id="chat-root"></div><div id="mobile-root"></div>`;
    this.screenRoot = this.root.querySelector('#screen-root')!;
    this.hudRoot = this.root.querySelector('#hud-root')!;
    this.modalRoot = this.root.querySelector('#modal-root')!;
    this.toastRoot = this.root.querySelector('#toast-root')!;
    this.reconnectRoot = this.root.querySelector('#reconnect-root')!;
    this.chatRoot = this.root.querySelector('#chat-root')!;
    this.mobileRoot = this.root.querySelector('#mobile-root')!;
    this.canvas = this.root.querySelector('#world-canvas')!;
    this.world = new GameWorld(this.canvas);
    this.loadCustomization(); this.world.setCustomization(this.customizationNames, this.customizationColors);
    this.bindEvents();
    this.renderMenu();
    this.startGameLoops();
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    this.user = await this.auth.restore();
    if (this.user && !this.user.guest) this.scheduleTokenRefresh();
    this.updateIdentityPill();
    const match = window.location.pathname.match(/\/join\/([a-f0-9]{64})\/?$/i);
    if (match?.[1]) {
      this.pendingJoin = { inviteToken: match[1] };
      this.openJoinModal(match[1]);
    }
    const resetToken = new URLSearchParams(window.location.search).get('reset');
    if (resetToken) {
      this.openResetModal(resetToken);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  private bindEvents(): void {
    this.screenRoot.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) return;
      event.preventDefault(); void this.handleAction(target.dataset.action ?? '', target);
    });
    this.hudRoot.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) return;
      event.preventDefault(); void this.handleAction(target.dataset.action ?? '', target);
    });
    this.modalRoot.addEventListener('click', (event) => {
      const clicked = event.target as HTMLElement;
      if (clicked.classList.contains('modal-backdrop')) { this.closeModal(); return; }
      const target = clicked.closest<HTMLElement>('[data-action]');
      if (!target || target.classList.contains('modal-backdrop')) return;
      event.preventDefault(); void this.handleAction(target.dataset.action ?? '', target);
    });
    this.screenRoot.addEventListener('submit', (event) => { if ((event.target as HTMLElement).matches('#join-form')) { event.preventDefault(); void this.submitJoinForm(); } });
    this.modalRoot.addEventListener('submit', (event) => {
      const form = event.target as HTMLFormElement;
      if (form.id === 'auth-form') { event.preventDefault(); void this.submitAuthForm(form); }
      if (form.id === 'forgot-form') { event.preventDefault(); void this.submitForgotForm(form); }
      if (form.id === 'reset-form') { event.preventDefault(); void this.submitResetForm(form); }
      if (form.id === 'chat-form') { event.preventDefault(); void this.submitChat(form); }
    });
    this.screenRoot.addEventListener('change', (event) => { if ((event.target as HTMLElement).id === 'room-private') void this.changePrivacy((event.target as HTMLInputElement).checked); });
    this.modalRoot.addEventListener('change', (event) => { if ((event.target as HTMLElement).id === 'audio-toggle') this.toggleAudio((event.target as HTMLInputElement).checked); });
    this.hudRoot.addEventListener('pointerdown', (event) => this.handleJoystickDown(event));
    this.hudRoot.addEventListener('pointermove', (event) => this.handleJoystickMove(event));
    this.hudRoot.addEventListener('pointerup', (event) => this.handleJoystickUp(event));
    this.hudRoot.addEventListener('pointercancel', (event) => this.handleJoystickUp(event));
    this.canvas.addEventListener('pointerdown', (event) => {
      if (this.screen !== 'game' || event.button !== 0) return;
      this.pointerDragging = true; this.lastPointer = { x: event.clientX, y: event.clientY };
    });
    window.addEventListener('pointerup', () => { this.pointerDragging = false; });
    window.addEventListener('pointermove', (event) => {
      if (this.pointerDragging && this.screen === 'game') {
        this.world.setCameraDelta(event.clientX - this.lastPointer.x, event.clientY - this.lastPointer.y);
        this.lastPointer = { x: event.clientX, y: event.clientY };
      }
    });
    this.canvas.addEventListener('contextmenu', (event) => {
      if (this.screen !== 'game') return;
      event.preventDefault(); const position = this.world.getControlledPosition();
      if (this.room && this.network.connected) this.network.raw?.emit('room:ping', { x: position.x, z: position.z, kind: 'danger' });
      this.showToast('Danger marker placed');
    });
    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.onKeyUp(event));
    window.addEventListener('blur', () => { this.keyState.clear(); this.mobileInput = { x: 0, z: 0, jump: false }; this.updateControls(); });
    window.addEventListener('beforeunload', () => { this.network.disconnect(); this.ambience.dispose(); });
  }

  private async handleAction(action: string, element: HTMLElement): Promise<void> {
    switch (action) {
      case 'play-solo': await this.playSolo(); break;
      case 'create-room': await this.createRoom(); break;
      case 'open-join': this.openJoinModal(); break;
      case 'open-auth': this.openAuthModal('login'); break;
      case 'open-register': this.openAuthModal('register'); break;
      case 'open-settings': this.openSettingsModal(); break;
      case 'save-customization': this.saveCustomization(); break;
      case 'account': await this.openAccountModal(); break;
      case 'logout': await this.logout(); break;
      case 'switch-auth': this.openAuthModal((element.dataset.mode as AuthMode) ?? 'login'); break;
      case 'google-auth': window.location.href = '/api/auth/google'; break;
      case 'guest-auth': await this.guestLogin(this.readInput('guest-name') || 'Milo'); break;
      case 'close-modal': this.closeModal(); break;
      case 'kick-player': await this.kickPlayer(element.dataset.playerId ?? ''); break;
      case 'legal-terms': this.showLegal('Terms of Use'); break;
      case 'legal-privacy': this.showLegal('Privacy Policy'); break;
      case 'skip-intro': await this.beginSoloGame(); break;
      case 'intro-next': this.nextIntro(); break;
      case 'puzzle-rotate': this.rotatePuzzle(Number(element.dataset.index)); break;
      case 'puzzle-confirm': this.confirmPuzzle(); break;
      case 'submit-join': await this.submitJoinForm(); break;
      case 'browse-public': await this.browsePublicRooms(); break;
      case 'join-public': await this.joinRoom({ code: element.dataset.code ?? '' }, this.modalRoot.querySelector<HTMLInputElement>('#join-name')?.value.trim() || 'Milo'); break;
      case 'copy-invite': await this.copyInvite(); break;
      case 'regenerate-invite': await this.regenerateInvite(); break;
      case 'ready': await this.toggleReady(); break;
      case 'start-match': await this.startMatch(); break;
      case 'leave-lobby': await this.leaveLobby(); break;
      case 'pause': this.pauseGame(); break;
      case 'resume': this.resumeGame(); break;
      case 'return-menu': await this.returnToMenu(); break;
      case 'interact': await this.interact(); break;
      case 'jump': this.mobileInput.jump = true; this.updateControls(); window.setTimeout(() => { this.mobileInput.jump = false; this.updateControls(); }, 220); break;
      case 'mute': this.toggleAudio(!this.isMuted); break;
      case 'toggle-chat': this.toggleChat(); break;
      case 'send-emote': this.sendEmote(element.dataset.emote ?? 'wave'); break;
      case 'use-join-code': this.openJoinModal(); break;
      case 'continue-level': await this.returnToMenu(); break;
      case 'quit': this.openQuitModal(); break;
      case 'mute-user': this.mutedUsers.add(element.dataset.userId ?? ''); this.showToast('Player muted on this device'); this.renderChat(); break;
      case 'report-user': this.reportUser(element.dataset.userId ?? ''); break;
      case 'logout-everywhere': await this.logoutEverywhere(); break;
      case 'delete-account': await this.deleteAccount(); break;
      case 'forgot-password': this.openAuthModal('forgot'); break;
      case 'auth-google': window.location.href = '/api/auth/google'; break;
    }
  }

  private renderMenu(): void {
    this.screen = 'menu'; this.hudRoot.innerHTML = ''; this.chatRoot.innerHTML = ''; this.mobileRoot.innerHTML = ''; this.reconnectRoot.innerHTML = '';
    this.screenRoot.innerHTML = `
      <div class="menu-screen screen-enter">
        <header class="topbar">
          <a class="brand" href="#" aria-label="Dargaze home" data-action="return-menu"><span class="brand-sigil">D</span><span><strong>DARGAZE</strong><small>THE ASHEN ODYSSEY</small></span></a>
          <div class="topbar-right"><button class="icon-text" data-action="open-settings"><span class="settings-glyph">⚙</span><span>Settings</span></button>
            <button class="identity-pill" data-action="${this.user ? 'account' : 'open-auth'}"><span class="avatar-chip">${escapeHtml(initials(this.user?.name ?? 'Guest'))}</span><span class="identity-copy"><b>${escapeHtml(this.user?.name ?? 'Guest wanderer')}</b><small>${this.user ? this.user.guest ? 'TEMPORARY ACCOUNT' : 'ACCOUNT CONNECTED' : 'PLAYING AS GUEST'}</small></span><span class="chevron">⌄</span></button>
          </div>
        </header>
        <main class="menu-main">
          <section class="menu-copy">
            <div class="eyebrow"><span class="eyebrow-mark"></span> A THREE-SOUL CO-OP ADVENTURE</div>
            <div class="title-lockup"><h1>DARGAZE</h1><span class="title-rule"></span><p class="subtitle">WHERE THE DARK<br><em>REMEMBERS YOUR NAME.</em></p></div>
            <p class="menu-description">Three boys. One impossible door. A world that should not exist. Find the Ember Crystals before the mountain wakes.</p>
            <div class="menu-actions">
              <button class="btn btn-primary" data-action="play-solo"><span class="btn-icon">▶</span><span><b>Begin the descent</b><small>Play solo · two AI companions</small></span><span class="btn-arrow">↗</span></button>
              <button class="btn btn-secondary" data-action="create-room"><span class="btn-icon outline">✦</span><span><b>Create a co-op room</b><small>Invite two friends to your party</small></span><span class="btn-arrow">↗</span></button>
              <button class="btn btn-tertiary" data-action="open-join"><span class="join-symbol">⌁</span><span>Join with a room code or invite link</span><span class="btn-arrow">→</span></button>
            </div>
            <div class="menu-footnote"><span class="pulse-dot"></span><span>PRIVATE ROOMS · UP TO 3 PLAYERS</span><span class="foot-divider">/</span><span>PC + MOBILE</span></div>
          </section>
          <aside class="world-caption"><div class="caption-line"></div><span class="caption-index">01 — THE EMBER CLIFFS</span><h2>It heard you<br><em>arrive.</em></h2><p>Something tall waits beyond the altar.</p><div class="caption-coordinates">ASHFALL FOREST &nbsp;·&nbsp; 03:17 AM</div></aside>
        </main>
        <div class="menu-bottom"><span>© DARGAZE · A STORY OF THREE FRIENDS</span><div><button data-action="open-settings">SETTINGS</button><button data-action="open-auth">ACCOUNT</button><button data-action="quit">QUIT</button></div><span class="build-stamp">EARLY DESCENT / 0.1</span></div>
        <div class="corner-coordinate">19° 31' S &nbsp;—&nbsp; 78° 21' E<br><span>THE CINDER REACH</span></div>
      </div>`;
    this.updateIdentityPill();
  }

  private updateIdentityPill(): void {
    if (this.screen !== 'menu') return;
    const pill = this.screenRoot.querySelector('.identity-pill'); if (!pill) return;
    pill.innerHTML = `<span class="avatar-chip">${escapeHtml(initials(this.user?.name ?? 'Guest'))}</span><span class="identity-copy"><b>${escapeHtml(this.user?.name ?? 'Guest wanderer')}</b><small>${this.user ? this.user.guest ? 'TEMPORARY ACCOUNT' : 'ACCOUNT CONNECTED' : 'PLAYING AS GUEST'}</small></span><span class="chevron">⌄</span>`;
    pill.setAttribute('data-action', this.user ? 'account' : 'open-auth');
  }

  private renderIntro(): void {
    this.screen = 'intro'; this.hudRoot.innerHTML = ''; this.mobileRoot.innerHTML = '';
    const copy = [
      { kicker: 'THE ORPHANAGE · BEFORE THE ASH', title: 'Three boys, one small world.', text: 'Milo had learned to be quiet. At the orphanage, the other children passed him by — until Ivo and Tavi sat beside him. After that, the three of them were never alone again.' },
      { kicker: 'THE WOODS · A DAY WITHOUT RULES', title: 'They ran until the trees changed.', text: 'They chased each other through the old forest, laughing too loudly for a place that had forgotten the sun. Then they found a tree with no leaves at all — yet taller than every living thing around it.' },
      { kicker: 'THE BARE TREE · THE ROOT RIDDLE', title: 'The trunk was waiting.', text: 'Ivo brushed the moss from three marks. “Roots point to the moon. Flame comes last.” Turn the symbols into the order the tree remembers.' },
      { kicker: 'DARGAZE · THE EMBER CLIFFS', title: 'The mountain opened its eye.', text: 'The portal took the boys in a rush of light and falling stone. Below them: rivers of fire, a black sky, and a treasure no one had ever found. Stay together. Find the Ember Crystals.' },
    ];
    const step = copy[this.introStep]!;
    const symbols = this.puzzleOrder.map((symbol) => `<button class="rune-tile" data-action="puzzle-rotate" data-index="${this.puzzleOrder.indexOf(symbol)}" aria-label="Rotate symbol">${this.symbolGlyph(symbol)}<small>${escapeHtml(symbol.toUpperCase())}</small></button>`).join('');
    this.screenRoot.innerHTML = `
      <div class="intro-screen screen-enter"><header class="intro-top"><a class="brand" data-action="return-menu"><span class="brand-sigil">D</span><span><strong>DARGAZE</strong><small>THE ASHEN ODYSSEY</small></span></a><button class="skip-link" data-action="skip-intro">SKIP PROLOGUE <span>↗</span></button></header>
        <div class="intro-sequence"><div class="sequence-track"><span class="sequence-fill" style="width:${((this.introStep + 1) / 4) * 100}%"></span></div><span class="sequence-count">0${this.introStep + 1} <i>/</i> 04</span></div>
        <section class="narration-card"><div class="eyebrow"><span class="eyebrow-mark"></span>${step.kicker}</div><h2>${step.title}</h2><p>${step.text}</p>
          ${this.introStep === 2 ? `<div class="rune-puzzle"><div class="rune-hint"><span>THE TREE'S MEMORY</span><b>ROOT → MOON → FLAME</b></div><div class="rune-row">${symbols}</div><div class="puzzle-status ${this.puzzleSolved ? 'solved' : ''}">${this.puzzleSolved ? 'THE BARK BEGINS TO GLOW' : 'TURN EACH MARK TO SET THE ORDER'}</div></div>` : ''}
          <div class="narration-actions"><button class="btn btn-primary" data-action="${this.introStep === 2 ? 'puzzle-confirm' : 'intro-next'}"><span><b>${this.introStep === 2 ? this.puzzleSolved ? 'Enter the portal' : 'Open the tree' : this.introStep === 3 ? 'Descend into Dargaze' : 'Continue'}</b><small>${this.introStep === 2 && !this.puzzleSolved ? 'Solve the three-symbol riddle' : 'The story is yours to finish'}</small></span><span class="btn-arrow">↗</span></button></div>
        </section><div class="intro-bottom-note"><span>PROLOGUE</span><span class="foot-divider">/</span><span>AN OPENING STORY · SKIPPABLE</span></div>
      </div>`;
    if (this.introStep === 2) this.world.setStage('tree');
    else if (this.introStep === 3) this.world.setStage('volcano');
    else this.world.setStage('forest');
  }

  private symbolGlyph(symbol: string): string { return symbol === 'root' ? 'ᚱ' : symbol === 'moon' ? '◐' : '✦'; }
  private rotatePuzzle(index: number): void {
    if (index < 0 || index > 2) return;
    const symbol = this.puzzleOrder[index]!;
    const cycle = ['flame', 'moon', 'root'];
    this.puzzleOrder[index] = cycle[(cycle.indexOf(symbol) + 1) % cycle.length]!;
    this.puzzleSolved = this.puzzleOrder.join(',') === 'root,moon,flame'; this.renderIntro();
  }
  private confirmPuzzle(): void {
    if (!this.puzzleSolved) { this.showToast('The symbols are still out of order.'); return; }
    this.introStep = 3; this.renderIntro();
  }
  private nextIntro(): void {
    if (this.introStep === 1) { this.introStep = 2; this.puzzleSolved = false; }
    else if (this.introStep === 0) this.introStep = 1;
    else if (this.introStep === 3) { void this.beginSoloGame(); return; }
    this.renderIntro();
  }

  private renderLobby(): void {
    const room = this.room; if (!room) { this.renderMenu(); return; }
    this.screen = 'lobby'; this.hudRoot.innerHTML = ''; this.mobileRoot.innerHTML = ''; this.chatRoot.innerHTML = '';
    const self = room.players.find((player) => player.id === this.user?.id);
    const isHost = room.hostId === this.user?.id;
    const inviteUrl = this.inviteToken ? `${window.location.origin}/join/${this.inviteToken}` : '';
    const players = [...room.players].sort((a, b) => a.slot - b.slot).map((player) => {
      const human = player.kind === 'human';
      const owner = player.id === room.hostId;
      const selfSlot = player.id === this.user?.id;
      const state = human ? player.connected ? player.ready ? 'READY' : 'NOT READY' : 'AI COVER · RECONNECT WINDOW' : 'AI COMPANION';
      return `<article class="slot-card ${human ? 'slot-human' : 'slot-ai'} ${selfSlot ? 'slot-self' : ''}"><div class="slot-top"><span class="slot-number">0${player.slot + 1} / 03</span><span class="slot-badge ${human ? 'badge-human' : 'badge-ai'}"><i></i>${human ? 'HUMAN' : 'AI'}</span></div><div class="slot-avatar ${human ? '' : 'ai-avatar'}">${human ? escapeHtml(initials(player.name)) : '✧'}</div><h3>${escapeHtml(player.name)}</h3><div class="slot-state ${player.ready ? 'is-ready' : ''}">${player.connected ? '<span class="ready-dot"></span>' : '<span class="offline-dot"></span>'}${state}</div>${owner ? '<span class="host-ribbon">HOST</span>' : ''}${selfSlot ? '<span class="you-tag">YOU</span>' : ''}${isHost && human && !owner && player.connected ? `<button class="slot-kick" data-action="kick-player" data-player-id="${escapeHtml(player.id)}" title="Kick player">×</button>` : ''}</article>`;
    }).join('');
    this.screenRoot.innerHTML = `
      <div class="lobby-screen screen-enter"><header class="topbar"><a class="brand" data-action="return-menu"><span class="brand-sigil">D</span><span><strong>DARGAZE</strong><small>THE ASHEN ODYSSEY</small></span></a><div class="lobby-breadcrumb"><span>PARTY</span><i>/</i><b>ROOM ${escapeHtml(room.code)}</b></div><div class="lobby-top-actions"><span class="lobby-ping"><i></i><b id="lobby-ping-value">${this.pingMs || '—'} MS</b></span><button class="icon-text" data-action="leave-lobby">LEAVE ROOM <span>↗</span></button></div></header>
        <main class="lobby-main"><div class="lobby-heading"><div><div class="eyebrow"><span class="eyebrow-mark"></span> THE PARTY GATHERS</div><h1>Three lights.<br><em>One way down.</em></h1><p>Any empty place is kept by a companion until a friend arrives.</p></div><div class="room-code-card"><span>ROOM CODE</span><strong>${escapeHtml(room.code)}</strong><small>SHARE WITH YOUR PARTY</small></div></div>
          <div class="party-slots">${players}</div>
          <section class="invite-panel"><div class="invite-copy"><span class="invite-icon">⌁</span><div><b>Bring your friends</b><small>Invite expires ${new Date(room.inviteExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div></div><div class="invite-control">${inviteUrl ? `<input aria-label="Invite link" readonly value="${escapeHtml(inviteUrl)}" />` : `<div class="invite-no-link">Join with code ${escapeHtml(room.code)}</div>`}<button class="btn btn-copy" data-action="copy-invite">${inviteUrl ? 'COPY LINK' : 'COPY CODE'}</button>${isHost ? '<button class="icon-square" data-action="regenerate-invite" title="Regenerate invite">↻</button>' : ''}</div></section>
          <div class="lobby-footer"><div class="privacy-control"><label for="room-private">PRIVATE ROOM</label><span>Only invited players can join</span><input type="checkbox" id="room-private" ${room.isPrivate ? 'checked' : ''} ${isHost ? '' : 'disabled'}><span class="switch-track"></span></div><div class="lobby-actions">${!isHost && self?.kind === 'human' ? `<button class="btn btn-secondary ready-button" data-action="ready"><span class="ready-indicator">${self.ready ? '✓' : '○'}</span>${self.ready ? 'READY — CLICK TO UNREADY' : 'I AM READY'}</button>` : ''}${isHost ? `<button class="btn btn-primary start-button" data-action="start-match" ${room.players.some((player) => player.kind === 'human' && player.connected && !player.ready) ? 'disabled' : ''}><span><b>Enter the Ember Cliffs</b><small>AI companions fill open slots</small></span><span class="btn-arrow">↗</span></button>` : '<div class="waiting-note"><span class="pulse-dot"></span> WAITING FOR THE HOST</div>'}</div></div>
          <div class="lobby-note"><span>01</span><span>THE EMBER CLIFFS</span><i></i><span>SHARED OBJECTIVES · 3 PLAYER CO-OP</span></div>
        </main><div class="lobby-bg-mark">D</div></div>`;
    if (this.pendingJoin) { history.replaceState({}, '', '/'); this.pendingJoin = null; }
  }

  private renderHud(): void {
    this.hudRoot.innerHTML = `
      <div class="game-hud">
        <header class="game-topbar"><div class="level-stamp"><span class="level-mark">D</span><div><small>LEVEL 01 / VOLCANIC REACH</small><b>THE EMBER CLIFFS</b></div></div><div class="hud-coop-status"><span class="network-light"></span><span id="network-label">${this.room ? 'PARTY LINK STABLE' : 'SOLO DESCENT'}</span>${this.room ? `<span class="hud-ping" id="hud-ping">${this.pingMs || '—'} ms</span>` : ''}<span class="hud-divider"></span><span id="hud-clock">03:17 AM</span></div><button class="pause-button" data-action="pause" aria-label="Pause game"><span>Ⅱ</span><small>ESC</small></button></header>
        <aside class="objective-card glass-card"><div class="card-eyebrow"><span class="objective-flare">✦</span> THE SHADOW'S TASK <span class="task-live">LIVE</span></div><h2 id="objective-title">Find 3 Ember Crystals</h2><p id="objective-copy">Carry them to the stone altar. Stay close to your friends.</p><div class="crystal-progress" id="crystal-progress"></div><div class="progress-caption"><span id="progress-copy">CRYSTALS RECOVERED</span><b id="progress-count">0 / 3</b></div><div class="progress-track"><span id="progress-bar"></span></div></aside>
        <aside class="party-card glass-card"><div class="party-card-heading"><span>YOUR PARTY</span><span class="party-count">3 <i>/</i> 3</span></div><div id="party-health"></div><div class="party-callout"><span class="tiny-light"></span> STAY WITHIN REACH</div></aside>
        <div class="health-dock"><div class="health-icon">✦</div><div class="health-meta"><span>VITALITY</span><div class="health-bar"><i id="self-health-bar"></i></div></div><b id="self-health-value">100</b></div>
        <div class="game-bottom-hints"><div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>MOVE</span></div><div><kbd>SPACE</kbd><span>JUMP</span></div><div><kbd>E</kbd><span>INTERACT</span></div><button data-action="toggle-chat" class="chat-shortcut"><span>◌</span> PARTY CHAT</button></div>
        <div class="interaction-prompt" id="interaction-prompt" hidden><span class="interact-key">E</span><span id="interaction-label">TAKE EMBER CRYSTAL</span><span class="prompt-arrow">↗</span><button data-action="interact" aria-label="Interact">INTERACT</button></div>
        <div class="emote-bubble" id="emote-bubble" hidden></div>
        <div class="touch-controls"><div class="joy-base" id="joystick"><div class="joy-ring"></div><div class="joy-knob" id="joystick-knob"></div><span class="joy-label">MOVE</span></div><div class="touch-actions"><button data-action="jump" class="touch-button jump-touch">↑<small>JUMP</small></button><button data-action="interact" class="touch-button interact-touch">E<small>USE</small></button></div></div>
        <button class="quick-emote" data-action="send-emote" data-emote="wave" title="Wave to your party">✋</button>
      </div>`;
    this.updateHud();
  }

  private updateHud(): void {
    if (this.screen !== 'game') return;
    const count = this.room?.crystals.length ?? this.world.collected.size;
    const gateOpen = this.room?.gateOpen ?? this.world.isGateOpen();
    const countEl = this.hudRoot.querySelector('#progress-count'); if (countEl) countEl.textContent = `${count} / 3`;
    const progress = this.hudRoot.querySelector<HTMLElement>('#progress-bar'); if (progress) progress.style.width = `${(count / 3) * 100}%`;
    const dots = this.hudRoot.querySelector<HTMLElement>('#crystal-progress');
    if (dots) dots.innerHTML = LEVELS.emberCliffs.crystals.map((crystal, index) => `<span class="crystal-dot ${index < count ? 'collected' : ''}" title="${escapeHtml(crystal.label)}">${index < count ? '✦' : '◇'}</span>`).join('');
    const title = this.hudRoot.querySelector<HTMLElement>('#objective-title'); const copy = this.hudRoot.querySelector<HTMLElement>('#objective-copy'); const progressCopy = this.hudRoot.querySelector<HTMLElement>('#progress-copy');
    if (gateOpen) { if (title) title.textContent = 'The gate is open'; if (copy) copy.textContent = 'Reach the ancient arch. The mountain is listening.'; if (progressCopy) progressCopy.textContent = 'ALTAR AWAKENED'; }
    const health = this.world.getHealth();
    const healthBar = this.hudRoot.querySelector<HTMLElement>('#self-health-bar'); if (healthBar) healthBar.style.width = `${health}%`;
    const healthValue = this.hudRoot.querySelector<HTMLElement>('#self-health-value'); if (healthValue) healthValue.textContent = `${Math.ceil(health)}`;
    const party = this.hudRoot.querySelector<HTMLElement>('#party-health');
    if (party) {
      const entries = this.world.getPartyHealth().sort((a, b) => a.name.localeCompare(b.name));
      party.innerHTML = entries.map((player) => `<div class="party-member ${player.downed ? 'member-downed' : ''}"><span class="party-avatar party-color-${player.kind}">${escapeHtml(initials(player.name))}</span><span class="party-member-info"><b>${escapeHtml(player.name)}${player.id === this.user?.id || player.id === 'solo-hero' ? ' <i>YOU</i>' : ''}</b><span class="party-health-line"><i style="width:${Math.max(0, player.health)}%"></i></span></span><span class="party-health-number">${player.downed ? 'DOWN' : Math.ceil(player.health)}</span></div>`).join('');
    }
    const target = this.world.getNearbyTarget(); this.currentTarget = target;
    const prompt = this.hudRoot.querySelector<HTMLElement>('#interaction-prompt'); const label = this.hudRoot.querySelector<HTMLElement>('#interaction-label');
    if (prompt) prompt.hidden = !target;
    if (label && target) label.textContent = target.label.toUpperCase();
    const clock = this.hudRoot.querySelector<HTMLElement>('#hud-clock'); if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const networkLabel = this.hudRoot.querySelector<HTMLElement>('#network-label'); if (networkLabel) networkLabel.textContent = this.room ? this.network.connected ? 'PARTY LINK STABLE' : 'RECONNECTING' : 'SOLO DESCENT';
    const pingLabel = this.hudRoot.querySelector<HTMLElement>('#hud-ping'); if (pingLabel) pingLabel.textContent = this.pingMs ? `${this.pingMs} ms` : '— ms';
    const shadowDistance = Math.hypot(this.world.getControlledPosition().x, this.world.getControlledPosition().z + 26.5);
    this.ambience.setEnemyProximity(shadowDistance);
    if (this.emoteUntil < Date.now()) { const bubble = this.hudRoot.querySelector<HTMLElement>('#emote-bubble'); if (bubble) bubble.hidden = true; }
  }

  private renderPause(): void {
    this.screenRoot.innerHTML = `<div class="game-overlay screen-enter"><div class="overlay-shade"></div><section class="pause-panel"><div class="eyebrow"><span class="eyebrow-mark"></span> DESCENT PAUSED</div><h2>Catch your breath.</h2><p>The ash is still falling. Your party will wait.</p><button class="btn btn-primary" data-action="resume"><span><b>Return to the cliffs</b><small>Continue your descent</small></span><span class="btn-arrow">↗</span></button><button class="pause-link" data-action="open-settings">Settings <span>→</span></button><button class="pause-link danger-link" data-action="return-menu">Leave this world <span>↗</span></button><div class="pause-party-note">${this.room ? `ROOM ${escapeHtml(this.room.code)} · PROGRESS IS SHARED` : 'YOUR AI COMPANIONS ARE WAITING'}</div></section></div>`;
  }

  private renderComplete(): void {
    this.screen = 'game'; this.hudRoot.innerHTML = ''; this.mobileRoot.innerHTML = ''; this.chatRoot.innerHTML = '';
    this.screenRoot.innerHTML = `<div class="complete-screen screen-enter"><div class="complete-orbit"></div><div class="complete-content"><div class="complete-icon">✦</div><div class="eyebrow"><span class="eyebrow-mark"></span> PARTY OBJECTIVE COMPLETE</div><h1>LEVEL 2<br><em>UNLOCKED</em></h1><p>The altar has heard your names.<br>The path ahead is open.</p><div class="complete-party">${this.world.getPartyHealth().map((p) => `<span>${escapeHtml(initials(p.name))}</span>`).join('')}</div><button class="btn btn-primary" data-action="continue-level"><span><b>Return to the title</b><small>Your progress is saved for the party</small></span><span class="btn-arrow">↗</span></button></div><div class="complete-coordinate">EMBER CLIFFS · 01: ??.??</div></div>`;
  }

  private openAuthModal(mode: AuthMode): void {
    this.authMode = mode;
    if (mode === 'forgot') {
      this.modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close-modal">×</button><div class="eyebrow"><span class="eyebrow-mark"></span> ACCOUNT RECOVERY</div><h2>Find your way back.</h2><p>We'll send an expiring reset link if an account exists for that email.</p><form id="forgot-form"><label class="form-label">EMAIL ADDRESS</label><input class="form-input" id="forgot-email" type="email" required autocomplete="email" placeholder="you@example.com"><div class="captcha-slot" id="turnstile-widget"></div><div id="modal-error" class="modal-error"></div><button class="btn btn-primary modal-submit" type="submit"><span><b>Send reset link</b><small>One-time link · expires in 30 minutes</small></span><span class="btn-arrow">↗</span></button></form></section></div>`;
      this.mountCaptcha();
      return;
    }
    const registering = mode === 'register';
    this.modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title"><button class="modal-close" data-action="close-modal" aria-label="Close">×</button><div class="eyebrow"><span class="eyebrow-mark"></span> ${registering ? 'MAKE A PLACE FOR YOURSELF' : 'RETURN TO YOUR PARTY'}</div><h2 id="auth-title">${registering ? 'Create your account.' : 'Come back to Dargaze.'}</h2><p>${registering ? 'Save your progress and keep your companions close.' : 'Your party, progress and devices stay in reach.'}</p>
        <button class="google-button" data-action="google-auth"><span class="google-g">G</span> Continue with Google <span>↗</span></button><div class="or-divider"><i></i><span>OR WITH EMAIL</span><i></i></div>
        <form id="auth-form">${registering ? '<label class="form-label">DISPLAY NAME</label><input class="form-input" name="name" required minlength="2" maxlength="24" autocomplete="nickname" placeholder="Milo" />' : ''}<label class="form-label">EMAIL ADDRESS</label><input class="form-input" name="email" type="email" required autocomplete="email" placeholder="you@example.com" /><label class="form-label">PASSWORD</label><input class="form-input" name="password" type="password" required ${registering ? 'minlength="10"' : ''} autocomplete="${registering ? 'new-password' : 'current-password'}" placeholder="${registering ? 'At least 10 characters' : 'Your password'}" />${registering ? '<small class="field-hint">Use upper + lowercase, a number and a symbol.</small>' : '<label class="form-label totp-label">AUTHENTICATOR CODE <span>OPTIONAL IF ENABLED</span></label><input class="form-input" name="totpCode" inputmode="numeric" maxlength="6" placeholder="000000" />'}<div class="captcha-slot" id="turnstile-widget"></div><div id="modal-error" class="modal-error"></div><button class="btn btn-primary modal-submit" type="submit"><span><b>${registering ? 'Create account' : 'Sign in'}</b><small>${registering ? 'A verification link will be sent' : 'Access token · 15 minute expiry'}</small></span><span class="btn-arrow">↗</span></button></form>
        <div class="auth-switch">${registering ? 'Already have an account?' : 'New to the cliffs?'} <button data-action="switch-auth" data-mode="${registering ? 'login' : 'register'}">${registering ? 'Sign in' : 'Create one'}</button>${!registering ? '<button class="forgot-link" data-action="forgot-password">Forgot password?</button>' : ''}</div>
        <div class="guest-separator"><span>OR BEGIN WITHOUT AN ACCOUNT</span></div><div class="guest-row"><input id="guest-name" class="form-input" value="${escapeHtml(this.user?.guest ? this.user.name : 'Milo')}" maxlength="24" aria-label="Guest display name"><button class="guest-button" data-action="guest-auth">Play as guest <span>→</span></button></div><div class="legal-note">By continuing you agree to the <a href="#terms" data-action="legal-terms">Terms</a> and <a href="#privacy" data-action="legal-privacy">Privacy Policy</a>. Parental consent is required for younger players.</div></section></div>`;
    this.mountCaptcha();
  }

  private loadCustomization(): void {
    try {
      const saved = JSON.parse(localStorage.getItem('dargaze.characters') ?? 'null') as { names?: string[]; colors?: string[] } | null;
      if (Array.isArray(saved?.names) && saved.names.length === 3) this.customizationNames = saved.names.map((name, index) => String(name).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 24) || ['Milo', 'Ivo', 'Tavi'][index]!);
      if (Array.isArray(saved?.colors) && saved.colors.length === 3) this.customizationColors = saved.colors.map((color, index) => /^#[0-9a-f]{6}$/i.test(String(color)) ? String(color) : ['#c35634', '#dfa44e', '#5c89a3'][index]!);
    } catch { /* use the default character palette */ }
  }

  private saveCustomization(): void {
    this.customizationNames = [0, 1, 2].map((slot) => {
      const value = this.modalRoot.querySelector<HTMLInputElement>(`#custom-name-${slot}`)?.value ?? '';
      return value.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 24) || ['Milo', 'Ivo', 'Tavi'][slot]!;
    });
    this.customizationColors = [0, 1, 2].map((slot) => {
      const value = this.modalRoot.querySelector<HTMLInputElement>(`#custom-color-${slot}`)?.value ?? '';
      return /^#[0-9a-f]{6}$/i.test(value) ? value : ['#c35634', '#dfa44e', '#5c89a3'][slot]!;
    });
    localStorage.setItem('dargaze.characters', JSON.stringify({ names: this.customizationNames, colors: this.customizationColors }));
    this.world.setCustomization(this.customizationNames, this.customizationColors);
    this.showToast('Character names and colors saved on this device.');
  }

  private openSettingsModal(): void {
    this.modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card settings-modal" role="dialog" aria-modal="true"><button class="modal-close" data-action="close-modal">×</button><div class="eyebrow"><span class="eyebrow-mark"></span> PERSONALIZE THE DESCENT</div><h2>Settings.</h2><p>The mountain is loud. Set the sound to your liking.</p><div class="setting-row"><div><b>Ambient soundscape</b><small>Wind, distant rumble and a warning heartbeat</small></div><label class="toggle-switch"><input id="audio-toggle" type="checkbox" ${this.isMuted ? '' : 'checked'}><span></span></label></div><div class="setting-row"><div><b>Mouse look</b><small>Drag the scene to look around during play</small></div><span class="setting-value">DRAG TO LOOK</span></div><div class="character-settings"><div class="settings-section-title">YOUR THREE FRIENDS <small>SOLO / AI COMPANIONS</small></div>${[0, 1, 2].map((slot) => `<div class="character-row"><label for="custom-name-${slot}">${slot === 0 ? 'THE HERO' : slot === 1 ? 'FRIEND ONE' : 'FRIEND TWO'}</label><input id="custom-name-${slot}" maxlength="24" value="${escapeHtml(this.customizationNames[slot] ?? '')}" /><input id="custom-color-${slot}" type="color" value="${escapeHtml(this.customizationColors[slot] ?? '#c35634')}" aria-label="Choose ${slot === 0 ? 'hero' : 'friend'} color"></div>`).join('')}<button class="custom-save" data-action="save-customization">SAVE CHARACTER DETAILS <span>↗</span></button><small>Online names use your account or join name.</small></div><div class="settings-section"><span>CONTROLS</span><p><kbd>W A S D</kbd> Move <i>·</i> <kbd>SPACE</kbd> Jump <i>·</i> <kbd>E</kbd> Interact</p><p><kbd>ESC</kbd> Pause <i>·</i> Right click Danger ping</p></div><div class="legal-note">Dargaze is a work in progress. No purchase is required. Player chat is filtered and can be muted or reported.</div></section></div>`;
  }

  private async openAccountModal(): Promise<void> {
    if (!this.user) { this.openAuthModal('login'); return; }
    if (this.user.guest) {
      this.modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close-modal">×</button><div class="eyebrow"><span class="eyebrow-mark"></span> TEMPORARY COMPANION</div><h2>${escapeHtml(this.user.name)}.</h2><p>Guest progress is temporary and this account has no persistent personal data. Create an account to keep your journey between visits.</p><button class="btn btn-primary modal-submit" data-action="open-register"><span><b>Create an account</b><small>Keep your progress and manage devices</small></span><span class="btn-arrow">↗</span></button><button class="pause-link danger-link" data-action="logout">Sign out <span>↗</span></button></section></div>`; return;
    }
    this.modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card account-modal" role="dialog" aria-modal="true"><button class="modal-close" data-action="close-modal">×</button><div class="eyebrow"><span class="eyebrow-mark"></span> ACCOUNT & SESSIONS</div><h2>${escapeHtml(this.user.name)}.</h2><p>${escapeHtml(this.user.email ?? '')} · access token renews every 15 minutes.</p><div id="sessions-list" class="sessions-list"><span class="loading-line">Loading active devices…</span></div><button class="pause-link" data-action="logout-everywhere">Log out everywhere <span>↗</span></button><button class="pause-link danger-link" data-action="delete-account">Delete account <span>↗</span></button><div class="legal-note">Account deletion is permanent and removes saved progress, active sessions and account data.</div></section></div>`;
    try {
      const response = await fetch('/api/auth/sessions', { headers: { Authorization: `Bearer ${this.auth.token}` }, credentials: 'include' });
      const data = await response.json() as { sessions?: Array<{ id: string; device_label: string; created_at: string; last_seen_at: string; current?: boolean }> };
      const container = this.modalRoot.querySelector('#sessions-list');
      if (container) container.innerHTML = (data.sessions ?? []).map((session) => `<div class="session-row"><span class="session-device">▣</span><span><b>${escapeHtml(session.device_label || 'Browser')}</b><small>${session.current ? 'THIS DEVICE · ' : ''}last seen ${new Date(session.last_seen_at).toLocaleString()}</small></span><i>${session.current ? 'ACTIVE' : 'SESSION'}</i></div>`).join('') || '<div class="empty-sessions">No active sessions.</div>';
    } catch { const container = this.modalRoot.querySelector('#sessions-list'); if (container) container.textContent = 'Session list is unavailable.'; }
  }

  private openJoinModal(prefill = ''): void {
    this.modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card join-modal" role="dialog" aria-modal="true" aria-labelledby="join-title"><button class="modal-close" data-action="close-modal" aria-label="Close">×</button><div class="eyebrow"><span class="eyebrow-mark"></span> YOUR FRIENDS ARE WAITING</div><h2 id="join-title">Find your party.</h2><p>Paste a private invite link, or enter the six-character room code.</p><button class="public-browser" data-action="browse-public">Browse open rooms <span>⌄</span></button><div id="public-room-list" class="public-room-list"></div><form id="join-form"><label class="form-label">INVITE LINK OR ROOM CODE</label><div class="input-with-icon"><span>⌁</span><input id="join-locator" required autocomplete="off" placeholder="D4RGZ8 or https://…/join/…" value="${escapeHtml(prefill)}" maxlength="500" /></div><label class="form-label">YOUR NAME IN THE ASHES</label><input id="join-name" class="form-input" required minlength="2" maxlength="24" value="${escapeHtml(this.user?.name ?? 'Milo')}" /><div class="modal-error" id="modal-error"></div><button class="btn btn-primary modal-submit" type="submit"><span><b>Join the room</b><small>AI companion hands over your slot</small></span><span class="btn-arrow">↗</span></button></form><div class="modal-bottom-note"><span>3 PLAYER CO-OP</span><i></i><span>INVITES EXPIRE AFTER 30 MINUTES</span></div></section></div>`;
  }

  private mountCaptcha(): void {
    const sitekey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
    const holder = this.modalRoot.querySelector<HTMLElement>('#turnstile-widget');
    this.captchaToken = ''; this.captchaWidgetId = null;
    if (!sitekey || !holder) { if (holder) holder.hidden = true; return; }
    holder.hidden = false;
    const render = () => {
      if (!holder.isConnected || !window.turnstile) return;
      this.captchaWidgetId = window.turnstile.render(holder, {
        sitekey, theme: 'dark',
        callback: (token) => { this.captchaToken = token; },
        'expired-callback': () => { this.captchaToken = ''; },
        'error-callback': () => { this.captchaToken = ''; },
      });
    };
    if (window.turnstile) { render(); return; }
    let script = document.querySelector<HTMLScriptElement>('#dargaze-turnstile');
    if (!script) {
      script = document.createElement('script'); script.id = 'dargaze-turnstile'; script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.defer = true;
      script.addEventListener('load', render, { once: true }); document.head.appendChild(script);
    } else script.addEventListener('load', render, { once: true });
  }

  private readCaptchaResponse(): string {
    return this.modalRoot.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')?.value ?? '';
  }

  private openResetModal(token: string): void {
    this.modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true"><div class="eyebrow"><span class="eyebrow-mark"></span> ACCOUNT RECOVERY</div><h2>Choose a new password.</h2><p>This one-time link expires shortly after it was sent.</p><form id="reset-form"><input type="hidden" name="token" value="${escapeHtml(token)}"><label class="form-label">NEW PASSWORD</label><input class="form-input" name="password" type="password" minlength="10" required autocomplete="new-password"><small class="field-hint">Upper + lowercase, a number and a symbol.</small><div id="modal-error" class="modal-error"></div><button class="btn btn-primary modal-submit" type="submit"><span><b>Update password</b></span><span class="btn-arrow">↗</span></button></form></section></div>`;
  }

  private openQuitModal(): void {
    this.modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close-modal">×</button><div class="eyebrow"><span class="eyebrow-mark"></span> THE ASH WILL WAIT</div><h2>Ready to leave?</h2><p>Close this browser tab to quit Dargaze. Your story will be here when you return.</p><button class="btn btn-primary modal-submit" data-action="close-modal"><span><b>Stay a little longer</b><small>There are three crystals to find</small></span><span class="btn-arrow">↗</span></button></section></div>`;
  }

  private async submitAuthForm(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form); const error = this.modalRoot.querySelector<HTMLElement>('#modal-error'); if (error) error.textContent = '';
    try {
      if (this.authMode === 'register') {
        const result = await this.auth.register(String(data.get('email') ?? ''), String(data.get('password') ?? ''), String(data.get('name') ?? ''), this.captchaToken || this.readCaptchaResponse());
        this.showToast(result.message); this.openAuthModal('login'); return;
      }
      const result = await this.auth.login(String(data.get('email') ?? ''), String(data.get('password') ?? ''), String(data.get('totpCode') ?? '') || undefined, this.captchaToken || this.readCaptchaResponse());
      this.user = result.user; this.closeModal(); this.updateIdentityPill(); this.scheduleTokenRefresh(); this.showToast(`Welcome back, ${result.user.name}.`);
      if (this.pendingJoin) await this.joinRoom(this.pendingJoin);
    } catch (reason) { if (error) error.textContent = (reason as Error).message; }
  }

  private async submitForgotForm(form: HTMLFormElement): Promise<void> {
    const email = String(new FormData(form).get('email') ?? ''); const error = this.modalRoot.querySelector<HTMLElement>('#modal-error');
    try {
      const response = await fetch('/api/auth/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email, ...(this.captchaToken || this.readCaptchaResponse() ? { captchaToken: this.captchaToken || this.readCaptchaResponse() } : {}) }) });
      const data = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not send a reset link.');
      this.showToast(data.message ?? 'If an account matches, a reset email is on its way.'); this.openAuthModal('login');
    } catch (reason) { if (error) error.textContent = (reason as Error).message; }
  }

  private async submitResetForm(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form); const error = this.modalRoot.querySelector<HTMLElement>('#modal-error');
    try {
      const response = await fetch('/api/auth/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ token: data.get('token'), password: data.get('password') }) });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Reset link is invalid.');
      this.showToast(result.message ?? 'Password changed.'); this.closeModal(); this.openAuthModal('login');
    } catch (reason) { if (error) error.textContent = (reason as Error).message; }
  }

  private async guestLogin(name: string): Promise<void> {
    try {
      const result = await this.auth.guest(name); this.user = result.user; this.closeModal(); this.updateIdentityPill(); this.showToast('Guest account ready. Your story is temporary.');
      if (this.pendingJoin) await this.joinRoom(this.pendingJoin, result.user.name);
    } catch {
      this.user = { id: `local-${crypto.randomUUID()}`, name: name.trim() || 'Milo', guest: true }; this.closeModal(); this.updateIdentityPill(); this.showToast('Offline guest mode. Co-op needs a live server.');
    }
  }

  private async ensureIdentity(name = 'Milo', allowOffline = false): Promise<AuthUser> {
    if (this.user && this.auth.token) return this.user;
    try {
      const result = await this.auth.guest(name); this.user = result.user; this.updateIdentityPill(); return this.user;
    } catch (error) {
      if (!allowOffline) throw error;
      this.user = { id: `local-${crypto.randomUUID()}`, name, guest: true }; return this.user;
    }
  }

  private async playSolo(): Promise<void> {
    this.ambience.start();
    try { await this.ensureIdentity('Milo', true); }
    catch { /* offline play remains available */ }
    this.introStep = 0; this.puzzleOrder = ['flame', 'root', 'moon']; this.puzzleSolved = false; this.renderIntro();
  }

  private async beginSoloGame(): Promise<void> {
    this.closeModal(); this.room = null; this.inviteToken = ''; this.network.disconnect();
    if (!this.user) this.user = { id: 'local-solo', name: 'Milo', guest: true };
    this.ambience.start(); this.world.startSolo(); this.screen = 'game'; this.screenRoot.innerHTML = ''; this.renderHud(); this.renderTouchControls(); this.chatRoot.innerHTML = '';
    this.showToast('Stay together. The Black Shadow is watching.');
  }

  private async createRoom(): Promise<void> {
    this.ambience.start();
    try {
      const user = await this.ensureIdentity('Milo');
      await this.ensureNetwork();
      const result = await this.network.emitAck<{ room: RoomSnapshot; inviteToken: string }>('room:create', { playerName: user.name });
      this.room = result.room as RoomSnapshot; this.inviteToken = String(result.inviteToken ?? ''); this.renderLobby();
    } catch (error) { this.showToast((error as Error).message === 'Failed to fetch' ? 'The co-op server is unavailable.' : (error as Error).message); }
  }

  private async ensureNetwork(): Promise<void> {
    if (!this.auth.token) throw new Error('Sign in or play as a guest before joining a room.');
    const socket = this.network.connect(this.auth.token); this.bindNetworkEvents(socket);
    if (socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error('Could not connect to the co-op server.')); }, 9000);
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(new Error(error.message || 'Connection rejected')); };
      const cleanup = () => { window.clearTimeout(timeout); socket.off('connect', onConnect); socket.off('connect_error', onError); };
      socket.once('connect', onConnect); socket.once('connect_error', onError);
    });
  }

  private bindNetworkEvents(socket: ReturnType<NetworkClient['connect']>): void {
    if (this.netBoundSocket === socket) return; this.netBoundSocket = socket;
    socket.on('connect', () => {
      this.reconnectRoot.innerHTML = '';
      if (this.room && this.user && (this.screen === 'game' || this.screen === 'lobby')) {
        void this.network.emitAck<{ room: RoomSnapshot }>('room:join', { playerName: this.user.name, code: this.room.code })
          .then((result) => { this.room = result.room as RoomSnapshot; if (this.screen === 'lobby') this.renderLobby(); else this.world.updateRoomSnapshot(this.room, this.user?.id); this.showToast('Party link restored.'); })
          .catch((error) => { this.showReconnectOverlay((error as Error).message); });
      } else if (this.screen === 'game' || this.screen === 'lobby') this.showToast('Party link restored.');
    });
    socket.on('disconnect', () => {
      if (this.screen === 'game' && this.room) this.showReconnectOverlay();
      else if (this.screen === 'lobby') this.showToast('Connection lost. Reconnecting…');
    });
    socket.on('connect_error', (error: Error) => {
      if (this.screen === 'game' && this.room) this.showReconnectOverlay(error.message);
    });
    socket.on('room:update', (room: RoomSnapshot) => this.onRoomUpdate(room));
    socket.on('world:snapshot', (room: RoomSnapshot) => {
      if (this.screen === 'game' && this.room) { this.room = room; this.world.updateRoomSnapshot(room, this.user?.id); this.updateHud(); }
    });
    socket.on('room:invite', (value: { token: string }) => { this.inviteToken = value.token; if (this.screen === 'lobby') this.renderLobby(); });
    socket.on('game:event', (event: { type: string; message: string }) => {
      this.showToast(event.message);
      if (event.type === 'level-complete') this.renderComplete();
    });
    socket.on('room:chat', (message: { id: string; name: string; text: string; at: number }) => {
      if (!this.mutedUsers.has(message.id)) { this.chatHistory.push(message); this.chatHistory = this.chatHistory.slice(-30); this.renderChat(); }
    });
    socket.on('room:emote', (event: { id: string; emote: string }) => {
      const player = this.world.getPartyHealth().find((item) => item.id === event.id);
      this.showEmote(event.emote === 'help' ? '🆘' : event.emote === 'cheer' ? '✦' : event.emote === 'follow' ? '↓' : '✋', player?.name ?? 'A friend');
    });
    socket.on('room:ping', (event: { kind: 'look' | 'danger' | 'objective'; x: number; z: number }) => {
      this.world.showPing(event.x, event.z, event.kind);
      this.showToast(event.kind === 'danger' ? '⚠ A danger marker was placed.' : 'Party marker placed.');
    });
    socket.on('room:notice', (notice: { message: string }) => this.showToast(notice.message));
    socket.on('room:kicked', (notice: { reason: string }) => { this.room = null; this.inviteToken = ''; this.network.disconnect(); this.renderMenu(); this.showToast(notice.reason); });
  }

  private onRoomUpdate(room: RoomSnapshot): void {
    this.room = room;
    if (this.screen === 'lobby') {
      if (room.phase === 'playing') this.beginOnlineGame(room);
      else this.renderLobby();
      return;
    }
    if (this.screen === 'game') {
      this.world.updateRoomSnapshot(room, this.user?.id); this.updateHud();
      if (room.phase === 'complete') this.renderComplete();
    }
  }

  private beginOnlineGame(room: RoomSnapshot): void {
    if (!this.user) return;
    this.room = room; this.screen = 'game'; this.screenRoot.innerHTML = '';
    this.world.startOnline(room, this.user.id); this.renderHud(); this.renderTouchControls(); this.showToast('The Black Shadow has a task for your party.');
  }

  private async browsePublicRooms(): Promise<void> {
    const list = this.modalRoot.querySelector<HTMLElement>('#public-room-list');
    if (list) list.innerHTML = '<div class="public-room-empty">Listening for open parties…</div>';
    try {
      await this.ensureIdentity('Milo'); await this.ensureNetwork();
      const result = await this.network.emitAck<{ rooms: Array<{ code: string; players: number; createdAt: number }> }>('room:list', {});
      const rooms = result.rooms ?? [];
      if (!list) return;
      list.innerHTML = rooms.length ? rooms.map((room) => `<div class="public-room-row"><span><b>ROOM ${escapeHtml(room.code)}</b><small>${room.players} / 3 players · AI companions fill the rest</small></span><button data-action="join-public" data-code="${escapeHtml(room.code)}">JOIN ↗</button></div>`).join('') : '<div class="public-room-empty">No open parties right now. Create a room and invite your friends.</div>';
    } catch (error) { if (list) list.textContent = (error as Error).message; }
  }

  private async submitJoinForm(): Promise<void> {
    const input = this.screenRoot.querySelector<HTMLInputElement>('#join-locator') ?? this.modalRoot.querySelector<HTMLInputElement>('#join-locator');
    const nameInput = this.modalRoot.querySelector<HTMLInputElement>('#join-name');
    const error = this.modalRoot.querySelector<HTMLElement>('#modal-error');
    if (!input) return;
    const raw = input.value.trim(); if (error) error.textContent = '';
    let locator: { code?: string; inviteToken?: string };
    const token = raw.match(/(?:\/join\/)?([a-f\d]{64})(?:\/?(?:\?.*)?)?$/i)?.[1];
    if (token) locator = { inviteToken: token };
    else {
      const code = raw.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(-6);
      if (!/^[A-Z2-9]{6}$/.test(code)) { if (error) error.textContent = 'Enter a six-character room code or a valid invite link.'; return; }
      locator = { code };
    }
    const name = nameInput?.value.trim() || this.user?.name || 'Milo';
    try { await this.ensureIdentity(name); await this.joinRoom(locator, name); }
    catch (reason) { if (error) error.textContent = (reason as Error).message; }
  }

  private async joinRoom(locator: { code?: string; inviteToken?: string }, name = this.user?.name ?? 'Milo'): Promise<void> {
    const user = await this.ensureIdentity(name);
    await this.ensureNetwork();
    const result = await this.network.emitAck<{ room: RoomSnapshot }>('room:join', { playerName: user.name, ...locator });
    this.room = result.room as RoomSnapshot; this.closeModal(); this.pendingJoin = locator; this.renderLobby();
    this.showToast('Joined the party. Your companion handed over the lantern.');
  }

  private async toggleReady(): Promise<void> {
    if (!this.room || !this.user) return;
    const self = this.room.players.find((player) => player.id === this.user?.id);
    try { const result = await this.network.emitAck<{ room: RoomSnapshot }>('room:ready', { ready: !self?.ready }); this.room = result.room as RoomSnapshot; this.renderLobby(); }
    catch (error) { this.showToast((error as Error).message); }
  }

  private async startMatch(): Promise<void> {
    try { await this.network.emitAck('room:start', {}); }
    catch (error) { this.showToast((error as Error).message); }
  }

  private async changePrivacy(isPrivate: boolean): Promise<void> {
    if (!this.room) return;
    try { const result = await this.network.emitAck<{ room: RoomSnapshot }>('room:host', { action: 'privacy', isPrivate }); this.room = result.room as RoomSnapshot; this.renderLobby(); }
    catch (error) { this.showToast((error as Error).message); }
  }

  private async regenerateInvite(): Promise<void> {
    try {
      const result = await this.network.emitAck<{ inviteToken: string; room: RoomSnapshot }>('room:host', { action: 'regenerateInvite' });
      this.inviteToken = String(result.inviteToken ?? ''); this.room = result.room as RoomSnapshot; this.renderLobby(); this.showToast('A fresh invite is ready. The old one has expired.');
    } catch (error) { this.showToast((error as Error).message); }
  }

  private async copyInvite(): Promise<void> {
    const text = this.inviteToken ? `${window.location.origin}/join/${this.inviteToken}` : this.room?.code ?? '';
    try { await navigator.clipboard.writeText(text); this.showToast(this.inviteToken ? 'Invite link copied.' : 'Room code copied.'); }
    catch { this.showToast(`Share this code: ${this.room?.code ?? ''}`); }
  }

  private async leaveLobby(): Promise<void> {
    try { await this.network.emitAck('room:leave', {}); } catch { /* local leave remains possible */ }
    this.room = null; this.inviteToken = ''; this.network.disconnect(); this.renderMenu();
  }

  private async interact(): Promise<void> {
    const target = this.currentTarget ?? this.world.getNearbyTarget();
    if (!target) { this.showToast('There is nothing close enough to reach.'); return; }
    this.ambience.start();
    if (this.room) {
      try {
        const result = await this.network.emitAck<{ room: RoomSnapshot; message: string; completed?: boolean }>('game:interact', { targetId: target.id });
        this.room = result.room as RoomSnapshot; this.world.updateRoomSnapshot(this.room, this.user?.id); this.updateHud(); this.showToast(String(result.message ?? 'Done.'));
        if (result.completed) this.renderComplete();
      } catch (error) { this.showToast((error as Error).message); }
      return;
    }
    const result = this.world.applyLocalInteraction(target.id); this.updateHud(); this.showToast(result.message);
    if (result.complete) this.renderComplete();
  }

  private pauseGame(): void {
    if (this.screen !== 'game' || this.room?.phase === 'complete') return;
    this.keyState.clear(); this.mobileInput = { x: 0, z: 0, jump: false }; this.updateControls(); this.screen = 'game'; this.renderPause();
    this.screen = 'game';
  }
  private resumeGame(): void { this.screenRoot.innerHTML = ''; this.screen = 'game'; this.renderHud(); this.renderTouchControls(); }

  private async returnToMenu(): Promise<void> {
    if (this.room && this.network.connected && this.screen !== 'game') {
      try { await this.network.emitAck('room:leave', {}); } catch { /* continue */ }
    }
    this.room = null; this.inviteToken = ''; this.pendingJoin = null; this.network.disconnect(); this.netBoundSocket = null;
    this.world.returnToMenu(); this.renderMenu(); this.closeModal(); this.chatHistory = [];
  }

  private async logout(): Promise<void> {
    await this.auth.logout(); this.user = null; this.network.disconnect(); this.netBoundSocket = null; this.closeModal(); this.updateIdentityPill(); this.showToast('Signed out on this device.');
  }
  private async logoutEverywhere(): Promise<void> {
    if (!this.auth.token) return;
    const confirmed = window.confirm('Log out of every active device?'); if (!confirmed) return;
    try {
      await fetch('/api/auth/logout-everywhere', { method: 'POST', credentials: 'include', headers: { Authorization: `Bearer ${this.auth.token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': this.readCookie('dargaze_csrf') }, body: '{}' });
      await this.logout();
    } catch (error) { this.showToast((error as Error).message); }
  }
  private async deleteAccount(): Promise<void> {
    const confirmed = window.prompt('This is permanent. Type DELETE to remove your account and saved progress.'); if (confirmed !== 'DELETE') return;
    try {
      const response = await fetch('/api/auth/account', { method: 'DELETE', credentials: 'include', headers: { Authorization: `Bearer ${this.auth.token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': this.readCookie('dargaze_csrf') }, body: JSON.stringify({ confirm: 'DELETE' }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'Account deletion failed.');
      await this.logout(); this.showToast('Account data deleted.');
    } catch (error) { this.showToast((error as Error).message); }
  }

  private async kickPlayer(id: string): Promise<void> {
    if (!id || !window.confirm('Remove this player from the room? They will be banned from rejoining with the same invite.')) return;
    try {
      const result = await this.network.emitAck<{ room: RoomSnapshot }>('room:host', { action: 'kick', playerId: id });
      this.room = result.room as RoomSnapshot; this.renderLobby();
    } catch (error) { this.showToast((error as Error).message); }
  }

  private showLegal(title: string): void {
    const privacy = title === 'Privacy Policy';
    this.modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close-modal">×</button><div class="eyebrow"><span class="eyebrow-mark"></span> DARGAZE · ${privacy ? 'PLAYER PRIVACY' : 'THE AGREEMENT'}</div><h2>${privacy ? 'Privacy, plainly.' : 'Terms, plainly.'}</h2><p>${privacy ? 'Dargaze stores only the account data needed to sign in, manage sessions and save shared progress. Room and socket events are validated and security metadata may be retained to investigate abuse. Passwords are hashed; refresh tokens are stored as hashes; invite links expire. You can request account deletion from Account settings.' : 'Play respectfully. Do not share private information, harass other players, or attempt to exploit the game. Guest access is temporary. Registered progress is shared with the party; room hosts can remove players. The game is provided as an early-access experience and may change.'}</p><p>${privacy ? 'Chat is limited to your room, filtered, and includes mute/report controls. Do not use Dargaze to contact strangers outside the game.' : 'For minors, a parent or guardian should review the game and provide required consent. If you need help, use the in-game report button.'}</p><button class="btn btn-primary modal-submit" data-action="close-modal"><span><b>Understood</b></span><span class="btn-arrow">↗</span></button></section></div>`;
  }

  private async reportUser(id: string): Promise<void> {
    if (!id || !this.network.connected) return;
    try { await this.network.emitAck('room:report', { playerId: id, reason: 'chat' }); this.showToast('Report sent to moderation.'); }
    catch (error) { this.showToast((error as Error).message); }
  }

  private toggleChat(): void {
    if (!this.room) { this.showToast('Party chat is available in a co-op room.'); return; }
    this.chatOpen = !this.chatOpen; this.renderChat();
    if (this.chatOpen) this.chatRoot.querySelector<HTMLInputElement>('#chat-input')?.focus();
  }

  private renderChat(): void {
    if (!this.chatOpen || !this.room) { this.chatRoot.innerHTML = ''; return; }
    this.chatRoot.innerHTML = `<section class="chat-panel"><header><div><span class="chat-live-dot"></span><b>PARTY CHAT</b><small>Filtered · party only</small></div><button data-action="toggle-chat" aria-label="Close chat">×</button></header><div class="chat-messages">${this.chatHistory.map((message) => `<div class="chat-message"><div><b>${escapeHtml(message.name)}</b><span>${new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><p>${escapeHtml(message.text)}</p>${message.id !== this.user?.id ? `<div class="chat-actions"><button data-action="mute-user" data-user-id="${escapeHtml(message.id)}">MUTE</button><button data-action="report-user" data-user-id="${escapeHtml(message.id)}">REPORT</button></div>` : ''}</div>`).join('') || '<div class="chat-empty">No messages yet.<br>Stay close to your friends.</div>'}</div><div class="chat-emotes"><button data-action="send-emote" data-emote="wave">✋</button><button data-action="send-emote" data-emote="help">🆘</button><button data-action="send-emote" data-emote="cheer">✦</button><button data-action="send-emote" data-emote="follow">↓</button></div><form id="chat-form"><input id="chat-input" name="text" maxlength="240" autocomplete="off" placeholder="Message your party…"><button type="submit">SEND ↗</button></form></section>`;
    const messages = this.chatRoot.querySelector('.chat-messages'); if (messages) messages.scrollTop = messages.scrollHeight;
    this.chatRoot.querySelector('#chat-form')?.addEventListener('submit', (event) => { event.preventDefault(); void this.submitChat(event.target as HTMLFormElement); });
  }

  private async submitChat(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form); const text = String(data.get('text') ?? '').trim(); if (!text) return;
    try { await this.network.emitAck('room:chat', { text }); form.reset(); }
    catch (error) { this.showToast((error as Error).message); }
  }

  private sendEmote(emote: string): void {
    if (!this.room) { this.showToast('Your companions are with you.'); return; }
    this.network.raw?.emit('room:emote', { emote }); this.showEmote(emote === 'help' ? '🆘' : emote === 'cheer' ? '✦' : emote === 'follow' ? '↓' : '✋', 'You');
  }
  private showEmote(symbol: string, name: string): void {
    const bubble = this.hudRoot.querySelector<HTMLElement>('#emote-bubble'); if (!bubble) return;
    bubble.innerHTML = `<span>${escapeHtml(symbol)}</span><small>${escapeHtml(name)}</small>`; bubble.hidden = false; this.emoteUntil = Date.now() + 2600;
  }

  private renderTouchControls(): void {
    if (this.screen !== 'game') { this.mobileRoot.innerHTML = ''; return; }
    // The controls live inside the HUD, avoiding any localhost/API assumptions on mobile browsers.
  }

  private handleJoystickDown(event: PointerEvent): void {
    if (!(event.target as HTMLElement).closest('#joystick')) return;
    const base = this.hudRoot.querySelector<HTMLElement>('#joystick'); if (!base) return;
    this.joystickPointer = event.pointerId; base.setPointerCapture(event.pointerId); this.handleJoystickMove(event); event.preventDefault();
  }
  private handleJoystickMove(event: PointerEvent): void {
    if (this.joystickPointer !== event.pointerId) return;
    const base = this.hudRoot.querySelector<HTMLElement>('#joystick'); const knob = this.hudRoot.querySelector<HTMLElement>('#joystick-knob'); if (!base || !knob) return;
    const rect = base.getBoundingClientRect(); const dx = event.clientX - (rect.left + rect.width / 2); const dy = event.clientY - (rect.top + rect.height / 2);
    const max = Math.min(rect.width, rect.height) * 0.3; const length = Math.min(max, Math.hypot(dx, dy)); const angle = Math.atan2(dy, dx);
    const x = Math.cos(angle) * length; const y = Math.sin(angle) * length;
    knob.style.transform = `translate(${x}px, ${y}px)`; this.mobileInput.x = x / max; this.mobileInput.z = y / max; this.updateControls();
  }
  private handleJoystickUp(event: PointerEvent): void {
    if (this.joystickPointer !== event.pointerId) return;
    this.joystickPointer = null; this.mobileInput.x = 0; this.mobileInput.z = 0;
    const knob = this.hudRoot.querySelector<HTMLElement>('#joystick-knob'); if (knob) knob.style.transform = 'translate(0, 0)'; this.updateControls();
  }

  private updateControls(): void {
    const keyX = (this.keyState.has('d') || this.keyState.has('arrowright') ? 1 : 0) - (this.keyState.has('a') || this.keyState.has('arrowleft') ? 1 : 0);
    const keyZ = (this.keyState.has('s') || this.keyState.has('arrowdown') ? 1 : 0) - (this.keyState.has('w') || this.keyState.has('arrowup') ? 1 : 0);
    this.world.setControls({ moveX: this.mobileInput.x || keyX, moveZ: this.mobileInput.z || keyZ, jump: this.mobileInput.jump || this.keyState.has(' ') });
  }
  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
    if (key === 'escape') {
      if (this.modalRoot.innerHTML) this.closeModal(); else if (this.screen === 'game' && !this.screenRoot.querySelector('.game-overlay')) this.pauseGame(); else if (this.screenRoot.querySelector('.game-overlay')) this.resumeGame();
      return;
    }
    if (key === 'e' && this.screen === 'game') { event.preventDefault(); void this.interact(); return; }
    if (key === 'enter' && this.screen === 'game' && this.room) { this.toggleChat(); return; }
    this.keyState.add(key); this.updateControls();
  }
  private onKeyUp(event: KeyboardEvent): void { this.keyState.delete(event.key.toLowerCase()); this.updateControls(); }

  private startGameLoops(): void {
    this.networkTick = window.setInterval(() => {
      if (this.screen !== 'game' || !this.room || this.room.phase !== 'playing' || !this.network.connected) return;
      const input = this.world.getServerMovement();
      this.network.raw?.emit('player:input', { seq: ++this.inputSequence, ...input });
    }, 50);
    this.pingTick = window.setInterval(() => {
      if (!this.network.connected) return;
      const started = performance.now();
      void this.network.emitAck<{ serverTime: number }>('net:ping', {}, 2500).then(() => {
        this.pingMs = Math.round(performance.now() - started);
        const lobbyPing = this.screenRoot.querySelector<HTMLElement>('#lobby-ping-value'); if (lobbyPing) lobbyPing.textContent = `${this.pingMs} MS`;
        const hudPing = this.hudRoot.querySelector<HTMLElement>('#hud-ping'); if (hudPing) hudPing.textContent = `${this.pingMs} ms`;
      }).catch(() => { /* a missed ping is covered by the reconnect state */ });
    }, 5000);
    this.uiTick = window.setInterval(() => { if (this.screen === 'game' && !this.screenRoot.querySelector('.complete-screen')) this.updateHud(); }, 140);
  }

  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    if (!this.user || this.user.guest) return;
    this.refreshTimer = window.setInterval(async () => {
      if (await this.auth.refresh()) { if (this.network.connected) this.network.updateToken(this.auth.token); }
      else this.showToast('Your sign-in has expired. Reconnect to continue.');
    }, 10 * 60 * 1000);
  }

  private showReconnectOverlay(message = 'Trying to find the party…'): void {
    this.reconnectRoot.innerHTML = `<div class="reconnect-overlay"><div class="reconnect-mark"><span></span></div><strong>PARTY LINK LOST</strong><p>${escapeHtml(message)}</p><div class="reconnect-dots"><i></i><i></i><i></i></div><small>Your character is covered by AI for up to 5 minutes.</small></div>`;
  }

  private toggleAudio(muted: boolean): void { this.isMuted = muted; this.ambience.setMuted(muted); }
  private closeModal(): void { this.modalRoot.innerHTML = ''; }
  private showToast(message: string): void {
    this.toastRoot.innerHTML = `<div class="toast-message"><span class="toast-glyph">✦</span><span>${escapeHtml(message)}</span></div>`;
    window.clearTimeout(this.toastTimer); this.toastTimer = window.setTimeout(() => { this.toastRoot.innerHTML = ''; }, 3400);
  }
  private readInput(id: string): string { return this.modalRoot.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? ''; }
  private readCookie(name: string): string { return decodeURIComponent(document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''); }
}
