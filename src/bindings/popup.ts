import {Binding, render, RenderResultRenderer, RenderedComponentLike, Part, PartCallbackParameterMask} from '@pucelle/lupos.js'
import {Aligner, AlignerPosition, AlignerOptions, EventFirer, TransitionResult, fade, Transition, untilComplete, LayoutWatcher, DOMUtils, noop} from '@pucelle/ff'
import {Popup} from '../components'
import * as SharedPopups from './popup-helpers/shared-popups'
import {PopupState} from './popup-helpers/popup-state'
import {PopupTriggerBinder, TriggerType} from './popup-helpers/popup-trigger-binder'


/** Specified keys become partial, others persist as original. */
type PartialKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>


export interface PopupOptions extends AlignerOptions {

	/** 
	 * If specified, all the `:popup` binding with same key will
	 * try to share and reuse one popup content.
	 * Even can't reuse, it also destroy old one immediately and create new one.
	 * 
	 * If `key` provided, all same-keyed share popup content, `cacheable` will not work.
	 * 
	 * It's useful when there are many same-type popup contents existing,
	 * and you'd like only one of them exist to reduce disturb.
	 */
	readonly key: string

	/** 
	 * By which interaction type trigger the popup.
	 * Can be one of `hover | click | focus | contextmenu | none`.
	 * You should not change it after `:popup` initialized.
	 * Note when use `focus` type trigger, you must ensure element can get focus.
	 */
	readonly trigger: TriggerType

	/** 
	 * Specifies which element to align to.
	 * It can be a selector for trigger element to select a descendant element,
	 * or a function to receive trigger element and return a descendant element.
	 * 
	 * If omit, use current element to align to.
	 */
	alignTo: string | ((trigger: Element) => Element)

	/** 
	 * How the popup content would align with the trigger element.
	 * Reference to `AlignerPosition` type for more details.
	 * Default value is `b`, means align to the bottom position of trigger element.
	 */
	alignPosition: AlignerPosition

	/** 
	 * Delay showing in milliseconds, such that mouse hover unexpected will not cause layer popup.
	 * Only for `hover` and `focus` trigger types.
	 * Default value is `100`.
	 */
	showDelay: number

	/** 
	 * Delay hiding in milliseconds, such that mouse hover from `el` to `layer` will not cause it flush.
	 * Default value is `100`.
	 */
	hideDelay: number

	/** Transition options to play transition when popup hiding and showing. */
	transition: TransitionResult

	/** 
	 * If specified as `true`, will show popup immediately.
	 * Only works when initializing.
	 * Default value is `false`.
	 */
	showImmediately: boolean

	/** 
	 * If specified as `true`, popup element will get focus after pop-up.
	 * Only work when popup element can get focus.
	 * Default value is `false`.
	 */
	autoFocus: boolean

	/** 
	 * Whether the popup element is pointable and can interact with mouse.
	 * If specifies as `false`, popup element will be applied `pointer-events: none`.
	 * Default value is `true`.
	 */
	pointable: boolean

	/** 
	 * Whether caches the popup content after it hides,
	 * So later my reuse it when rendering same content.
	 * Especially when the popup-content is expensive to render.
	 * 
	 * If `key` provided, all same-keyed share popup content, `cacheable` will not work.
	 * 
	 * Default value is `false`.
	 */
	cacheable: boolean

	/** 
	 * If specified as `true`, will keep the popup visible once popup opened,
	 * until this value becomes `false`, or hide popup manually.
	 * If `keepVisible` is true, it prevents `key` based popup sharing.
	 * Default value is `false`.
	 */
	keepVisible: boolean
}

interface PopupBindingEvents {
	
	/** Fired after `opened` state of popup binding changed. */
	'opened-change'?: (opened: boolean) => void

	/** Fired before align popup content with trigger element. */
	'will-align'?: () => void
}


/** Default popup options. */
export const DefaultPopupOptions: PartialKeys<PopupOptions, 'key' | 'alignTo'> = {
	gap: 4,
	stickToEdges: true,
	canSwapPosition: true,
	canShrinkOnY: true,
	fixTriangle: false,

	alignPosition: 'b',
	trigger: 'hover',
	showDelay: 100,
	hideDelay: 200,
	transition: fade(),
	showImmediately: false,
	autoFocus: false,
	pointable: true,
	cacheable: false,
	keepVisible: false,
}


/**
 * A `:popup` binding can bind trigger element with it's popup content,
 * and make popup content get popped-up when interact with trigger element.
 * 
 * `:popup=${html`<Popup />`, ?{...}}`
 * `:popup=${() => html`<Popup />`, ?{...}}`
 */
export class popup extends EventFirer<PopupBindingEvents> implements Binding, Part {

	readonly el: HTMLElement

	protected readonly state: PopupState
	protected readonly binder: PopupTriggerBinder
	protected readonly transition: Transition

	protected options: PartialKeys<PopupOptions, 'key' | 'alignTo' | 'transition'> = DefaultPopupOptions
	protected renderer: RenderResultRenderer | null = null

	/** Used to watch rect change after popup opened. */
	protected unwatchRect: (() => void) = noop

	/** Help to update popup content by newly rendered result. */
	protected rendered: RenderedComponentLike | null = null

	/** Current popup component. */
	protected popup: Popup | null = null

	/** Align to current popup. */
	protected aligner: Aligner | null = null

	/** Whether have prevent hiding popup content. */
	protected preventedHiding: boolean = false

	constructor(el: Element) {
		super()

		this.el = el as HTMLElement
		this.binder = new PopupTriggerBinder(this.el)
		this.state = new PopupState()
		this.transition = new Transition(this.el)

		this.initEvents()
	}

	/** Whether popup content is opened. */
	get opened() {
		return this.state.opened
	}

	afterConnectCallback(_param: PartCallbackParameterMask | 0) {
		this.binder.setTriggerType(this.options.trigger)
		this.binder.bindEnter()

		if (this.options.showImmediately) {
			this.showPopupLater()
		}
	}

    beforeDisconnectCallback(_param: PartCallbackParameterMask | 0) {
		if (this.state.opened && this.popup) {
			this.popup.remove()
		}

		this.state.clear()
		this.binder.unbindLeave()
		this.unwatchRect()
		this.preventedHiding = false
	}

	protected initEvents() {
		this.binder.on('will-show', this.onWillShow, this)
		this.binder.on('will-hide', this.onWillHide, this)
		this.binder.on('cancel-show', this.onCancelShow, this)
		this.binder.on('immediate-hide', this.onImmediateHide, this)
		this.binder.on('toggle-show-hide', this.onToggleShowHide, this)

		this.state.on('do-show', this.doShowPopup, this)
		this.state.on('do-hide', this.doHidePopup, this)
	}

	/** Like mouse enter, and need to show soon. */
	protected onWillShow() {
		this.showPopupLater()
	}

	/** Like mouse leave, and need to hide soon. */
	protected onWillHide() {
		if (this.options.keepVisible) {
			this.preventedHiding = true
			return
		}

		this.hidePopupLater()
	}

	/** 
	 * Although we call it `cancel showing`,
	 * May still be in opened state right now.
	 */
	protected onCancelShow() {
		if (this.state.opened) {
			this.hidePopup()
		}
		else {
			this.state.willNotShow()
		}
	}

	/** Like trigger element become out-view, and need to hide immediately. */
	protected onImmediateHide() {
		if (this.options.keepVisible) {
			this.preventedHiding = true
			return
		}

		this.hidePopup()
	}

	/** Toggle opened state and show or hide popup content immediately. */
	protected onToggleShowHide() {
		if (this.state.opened) {
			this.state.hide()
		}
		else {
			this.state.show()
		}
	}

	/** Do show popup action. */
	protected doShowPopup() {
		this.doingShowPopup()
		this.fire('opened-change', true)
	}
	
	/** Do hide popup action. */
	protected doHidePopup() {
		this.doingHidePopup()
		this.fire('opened-change', false)
	}


	/** Show popup content after a short time out. */
	showPopupLater() {
		let showDelay = this.options.showDelay
		let key = this.options.key

		// If can reuse exist, show without delay.
		if (key && SharedPopups.isCacheOpened(key)) {
			showDelay = 0
		}

		// If have delay for `click` type trigger, it will feel like a stuck or slow responsive.
		if (this.binder.trigger === 'click' || this.binder.trigger === 'focus') {
			showDelay = 0
		}

		let willShow = this.state.willShow(showDelay)
		if (willShow) {
			this.binder.bindLeaveBeforeShow()
		}
	}

	/** Send a request to show popup content, can be called repeatedly. */
	showPopup() {
		this.state.show()
	}

	/** Send a request to hide popup content after a short time out. */
	hidePopupLater() {
		let hideDelay = this.options.hideDelay
		this.state.willHide(hideDelay)
	}

	/** Send a request to hide popup content, can be called repeatedly. */
	hidePopup() {
		this.state.hide()
	}


	update(renderer: RenderResultRenderer, options: Partial<PopupOptions> = {}) {
		this.renderer = renderer
		this.options = {...DefaultPopupOptions, ...options}

		// If popup has popped-up, should also update it.
		if (this.state.opened) {
			this.updatePopup()
		}

		// Options changed and no need to persist visible.
		if (this.preventedHiding && !this.options.keepVisible) {
			this.hidePopupLater()
		}
	}

	/** Show popup immediately, currently in opened. */
	protected async doingShowPopup() {
		await this.updatePopup()
		this.alignPopup()
	}

	/** Hide popup immediately, currently not in opened. */
	protected async doingHidePopup() {

		// Play leave transition if need.
		if (this.options.transition) {
			let finish = await this.transition.leave(this.options.transition)
			if (finish) {
				this.popup?.remove()
			}
		
			if (this.state.opened) {
				return
			}
		}

		this.binder.unbindLeave()
		this.unwatchRect()
		this.preventedHiding = false
	}

	/** Update popup content, if haven't rendered, render it firstly. */
	protected async updatePopup() {
		this.updateRenderedProperty()
		await untilComplete()

		// May soon become un-opened.
		if (!this.state.opened) {
			return
		}

		let popup = Popup.from(this.rendered!.el.firstElementChild!)
		if (!popup) {
			throw new Error(`The "renderer" of ":popup(renderer)" must render a "<Popup>" type of component!`)
		}

		// Update `pointable`.
		popup.el.style.pointerEvents = this.options.pointable ? '' : 'none'

		// Popup content get updated.
		if (popup !== this.popup) {
			this.updatePopupProperty(popup)
		}

		/** Append popup element into document. */
		this.appendPopup()

		if (this.options.key) {
			SharedPopups.add(this.options.key, {popup, rendered: this.rendered!})
			SharedPopups.setUser(popup, this)
		}
	}

	/** Update rendered property, and may use cache. */
	protected updateRenderedProperty() {
		if (this.rendered) {
			this.rendered.renderer = this.renderer!
		}

		if (!this.rendered) {
			let cache = this.options.key ? SharedPopups.find(this.options.key) : null
			if (cache) {
				this.rendered = cache.rendered
				this.popup = cache.popup
			}
		}

		if (!this.rendered) {
			this.rendered = render(this.renderer!)
		}
	}

	/** After popup first time updated. */
	protected updatePopupProperty(popup: Popup) {
		popup.setBinding(this)
		this.binder.bindLeave(this.options.hideDelay, popup.el)
		this.popup = popup
	}

	/** Append popup element into document. */
	protected appendPopup() {
		let inDomAlready = !!this.popup!.el.ownerDocument

		// Although in document, need append too.
		this.popup!.applyAppendTo()

		// May align not successfully.
		let aligned = this.alignPopup()
		if (!aligned) {
			return
		}

		this.mayGetFocus()

		// Play enter transition.
		if (!inDomAlready && this.options.transition) {
			this.transition.enter(this.options.transition)
		}

		// Watch it's rect changing.
		this.unwatchRect = LayoutWatcher.watch(this.el, 'rect', this.onTriggerRectChanged.bind(this))
	}

	/** After trigger element position changed. */
	protected onTriggerRectChanged() {
		if (DOMUtils.isRectIntersectWithViewport(this.el.getBoundingClientRect())) {
			this.alignPopup()
		}
		else {
			this.hidePopup()
		}

		this.unwatchRect = noop
	}

	/** Align popup content, returns whether align successfully. */
	protected alignPopup(): boolean {
		if (!this.state.opened) {
			return false
		}

		this.fire('will-align')
		let alignTo = this.getAlignToElement()

		// Update aligner if required.
		if (!this.aligner || this.aligner.anchor !== alignTo || this.aligner.content !== this.popup!.el) {
			this.aligner = new Aligner(this.popup!.el, alignTo, this.options.alignPosition, this.getAlignerOptions())
		}

		let aligned = this.aligner.align()
		if (!aligned) {
			this.hidePopup()
		}

		return aligned
	}

	/** Get element popup will align to. */
	protected getAlignToElement(): Element {
		if (!this.options.alignTo) {
			return this.el
		}
		else if (typeof this.options.alignTo === 'function') {
			return this.options.alignTo(this.el) ?? this.el
		}
		else {
			return this.el.querySelector(this.options.alignTo) ?? this.el
		}
	}

	/** Get options for Aligner. */
	protected getAlignerOptions(): AlignerOptions {
		let triangle = this.popup!.el.querySelector("[class$='-triangle']") as HTMLElement | null

		return {
			gap: this.options.gap,
			stickToEdges: this.options.stickToEdges,
			canSwapPosition: this.options.stickToEdges,
			canShrinkOnY: this.options.canShrinkOnY,
			fixTriangle: this.options.fixTriangle,
			triangle: triangle ?? undefined,
		}
	}

	/** Make element of popup content get focus if possible. */
	protected mayGetFocus() {
		let trigger = this.binder.trigger
		let popupEl = this.popup!.el

		if (this.options.autoFocus
			&& (trigger !== 'hover' && trigger !== 'focus')
			&& popupEl.tabIndex >= 0
		) {
			popupEl.focus()
		}
	}

	/** Returns whether the popup-content can be reused by key. */
	canContentReuse(): boolean {
		if (!this.options.key) {
			return false
		}
		
		if (this.options.keepVisible) {
			return !this.state.opened
		}

		return true
	}

	/** Clears popup content, reset to initial state. */
	clearContent() {
		if (this.state.opened && this.popup) {
			this.popup.remove()
		}

		if (this.options.key && this.popup) {
			SharedPopups.clearUser(this.popup)
		}

		this.binder.unbindLeave()
		this.state.clear()
		this.unwatchRect()
		this.rendered = null
		this.popup = null
		this.aligner = null
		this.preventedHiding = false
	}
}