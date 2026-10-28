import { PluginFileLogger } from '../util/PluginFileLogger';
import { processOutputLine, MarkerStreamContext } from '../session/MarkerParser';
import { MessageHandler } from '../session/MessageHandler';
import { SessionState } from '../session/SessionState';
import { CallbackHandler } from '../session/CallbackHandler';
import { SessionCallbackAdapter } from '../session/SessionCallbackAdapter';
import { StreamMessageCoalescer } from '../session/StreamMessageCoalescer';

export interface SessionLineSink {
	onLine(line: string): void;
	onStderr?(text: string): void;
}

/**
 * Per-session owner of the daemon output pipeline (data plane).
 * Tags every output line to the exact session instance.
 */
export class TabStreamRouter implements SessionLineSink {
	private readonly messageHandler: MessageHandler;
	private readonly streamContext: MarkerStreamContext = {
		assistantContent: '',
		hadSendError: false,
		lastNodeError: null,
		wasAborted: false,
	};

	private adapter: SessionCallbackAdapter | null = null;
	private coalescer: StreamMessageCoalescer | null = null;

	constructor(state: SessionState, callbackHandler: CallbackHandler) {
		this.messageHandler = new MessageHandler(state, callbackHandler);
	}

	attachOutputs(adapter: SessionCallbackAdapter | null, coalescer: StreamMessageCoalescer | null): void {
		this.adapter = adapter;
		this.coalescer = coalescer;
	}

	getAdapter(): SessionCallbackAdapter | null {
		return this.adapter;
	}

	getCoalescer(): StreamMessageCoalescer | null {
		return this.coalescer;
	}

	clearOutputs(): void {
		this.adapter = null;
		this.coalescer = null;
	}

	getMessageCallback(): MessageHandler {
		return this.messageHandler;
	}

	getStreamContext(): MarkerStreamContext {
		return this.streamContext;
	}

	onLine(line: string): void {
		try {
			processOutputLine(line, this.messageHandler, this.streamContext);
		} catch (err) {
			PluginFileLogger.warn('TabStreamRouter', `failed to process line: ${String(err)}`);
		}
	}

	onStderr(text: string): void {
		if (text && text.trim().length > 0) {
			try {
				this.messageHandler.onMessage('node_log', text);
			} catch (err) {
				PluginFileLogger.warn('TabStreamRouter', `failed to process stderr: ${String(err)}`);
			}
		}
	}
}
