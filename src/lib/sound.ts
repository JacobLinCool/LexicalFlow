let ctx: AudioContext | null = null;

function context(): AudioContext | null {
	if (typeof AudioContext === 'undefined') return null;
	ctx ??= new AudioContext();
	if (ctx.state === 'suspended') void ctx.resume();
	return ctx;
}

/** A short, soft sine blip; quiet enough to sit under continuous play. */
function blip(freqs: number[], duration: number, gain = 0.06): void {
	const ac = context();
	if (!ac) return;
	const t0 = ac.currentTime;
	freqs.forEach((freq, i) => {
		const osc = ac.createOscillator();
		const env = ac.createGain();
		const start = t0 + i * duration * 0.6;
		osc.type = 'sine';
		osc.frequency.setValueAtTime(freq, start);
		env.gain.setValueAtTime(0, start);
		env.gain.linearRampToValueAtTime(gain, start + 0.008);
		env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
		osc.connect(env).connect(ac.destination);
		osc.start(start);
		osc.stop(start + duration + 0.02);
	});
}

export const sounds = {
	/** Unlock audio inside a user gesture. */
	prime: () => void context(),
	correct: () => blip([880, 1318.5], 0.09),
	incorrect: () => blip([220], 0.14, 0.05),
	timeout: () => blip([196, 174.6], 0.12, 0.04)
};
