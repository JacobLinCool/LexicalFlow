/** Speech synthesis for saying a word aloud; silently absent where the browser has none. */

function synth(): SpeechSynthesis | null {
	return typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined'
		? null
		: speechSynthesis;
}

let primed = false;

/** Unlock speech inside a user gesture: some browsers (iOS Safari) refuse it otherwise. */
export function primeSpeech(): void {
	const s = synth();
	if (!s || primed) return;
	primed = true;
	s.speak(new SpeechSynthesisUtterance(''));
}

/** Stop speaking at once, e.g. when sound is muted mid-word. */
export function silence(): void {
	synth()?.cancel();
}

/** Say an English word, cutting off whatever was still being said. */
export function speak(word: string): void {
	const s = synth();
	if (!s) return;
	s.cancel();
	const utterance = new SpeechSynthesisUtterance(word);
	utterance.lang = 'en-US';
	utterance.rate = 0.95;
	s.speak(utterance);
}
