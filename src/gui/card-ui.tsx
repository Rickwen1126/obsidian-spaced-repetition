import { now } from "moment";
import { App, Notice, Platform, setIcon } from "obsidian";

import { RepItemScheduleInfo } from "src/algorithms/base/rep-item-schedule-info";
import { ReviewResponse } from "src/algorithms/base/repetition-item";
import { textInterval } from "src/algorithms/osr/note-scheduling";
import { Card } from "src/card";
import { Deck } from "src/deck";
import {
    FlashcardReviewMode,
    IFlashcardReviewSequencer as IFlashcardReviewSequencer,
} from "src/flashcard-review-sequencer";
import { FlashcardMode } from "src/gui/sr-modal";
import { t } from "src/lang/helpers";
import type SRPlugin from "src/main";
import { Note } from "src/note";
import { CardType, Question } from "src/question";
import { SRSettings } from "src/settings";
import { RenderMarkdownWrapper } from "src/utils/renderers";

export class CardUI {
    public app: App;
    public plugin: SRPlugin;
    public mode: FlashcardMode;

    public view: HTMLDivElement;

    public infoSection: HTMLDivElement;
    public deckProgressInfo: HTMLDivElement;

    public chosenDeckInfo: HTMLDivElement;
    public chosenDeckName: HTMLDivElement;

    public chosenDeckCounterWrapper: HTMLDivElement;
    public chosenDeckCounterDivider: HTMLDivElement;

    public chosenDeckCardCounterWrapper: HTMLDivElement;
    public chosenDeckCardCounter: HTMLDivElement;
    public chosenDeckCardCounterIcon: HTMLDivElement;

    public chosenDeckSubDeckCounterWrapper: HTMLDivElement;
    public chosenDeckSubDeckCounter: HTMLDivElement;
    public chosenDeckSubDeckCounterIcon: HTMLDivElement;

    public currentDeckInfo: HTMLDivElement;
    public currentDeckName: HTMLDivElement;

    public currentDeckCounterWrapper: HTMLDivElement;

    public currentDeckCounterDivider: HTMLDivElement;

    public currentDeckCardCounterWrapper: HTMLDivElement;
    public currentDeckCardCounter: HTMLDivElement;
    public currentDeckCardCounterIcon: HTMLDivElement;

    public cardContext: HTMLElement;

    public content: HTMLDivElement;

    public controls: HTMLDivElement;
    public editButton: HTMLButtonElement;
    public copyButton: HTMLButtonElement;
    public resetButton: HTMLButtonElement;
    public redoButton: HTMLButtonElement;
    public infoButton: HTMLButtonElement;
    public skipButton: HTMLButtonElement;

    public quickAppendControls: HTMLDivElement;
    public qCopyToFileButton: HTMLButtonElement;
    public qAddContentButton: HTMLButtonElement;

    public response: HTMLDivElement;
    public hardButton: HTMLButtonElement;
    public goodButton: HTMLButtonElement;
    public easyButton: HTMLButtonElement;
    public answerButton: HTMLButtonElement;
    public lastPressed: number;

    private currentAudio: HTMLAudioElement | null = null;

    private chosenDeck: Deck | null;
    private totalCardsInSession: number = 0;
    private totalDecksInSession: number = 0;

    private currentDeck: Deck | null;
    private previousDeck: Deck | null;
    private currentDeckTotalCardsInQueue: number = 0;

    private reviewSequencer: IFlashcardReviewSequencer;
    private settings: SRSettings;
    private reviewMode: FlashcardReviewMode;
    private backToDeck: () => void;
    private editClickHandler: () => void;

    constructor(
        app: App,
        plugin: SRPlugin,
        settings: SRSettings,
        reviewSequencer: IFlashcardReviewSequencer,
        reviewMode: FlashcardReviewMode,
        view: HTMLDivElement,
        backToDeck: () => void,
        editClickHandler: () => void,
    ) {
        // Init properties
        this.app = app;
        this.plugin = plugin;
        this.settings = settings;
        this.reviewSequencer = reviewSequencer;
        this.reviewMode = reviewMode;
        this.backToDeck = backToDeck;
        this.editClickHandler = editClickHandler;
        this.view = view;
        this.chosenDeck = null;

        // Build ui
        this.init();
    }

    // #region -> public methods

    /**
     * Initializes all static elements in the FlashcardView
     */
    init() {
        this.view.addClasses(["sr-flashcard", "sr-is-hidden"]);

        this.controls = this.view.createDiv();
        this.controls.addClass("sr-controls");

        this._createCardControls();

        // 新增第二排按鈕
        this.quickAppendControls = this.view.createDiv();
        this.quickAppendControls.addClass("sr-quick-append-controls");
        this._createQuickAppendButtons();

        this._createInfoSection();

        this.content = this.view.createDiv();
        this.content.addClass("sr-content");

        this.response = this.view.createDiv();
        this.response.addClass("sr-response");

        this._createResponseButtons();
    }

    /**
     * Shows the FlashcardView if it is hidden
     */
    async show(chosenDeck: Deck) {
        // Prevents rest of code, from running if this was executed multiple times after one another
        if (!this.view.hasClass("sr-is-hidden")) {
            return;
        }

        this.chosenDeck = chosenDeck;
        const deckStats = this.reviewSequencer.getDeckStats(chosenDeck.getTopicPath());
        this.totalCardsInSession = deckStats.cardsInQueueCount;
        this.totalDecksInSession = deckStats.decksInQueueOfThisDeckCount;

        // Clear redo lists on session start
        this.reviewSequencer.clearRedoLists();

        await this._drawContent();

        this.view.removeClass("sr-is-hidden");
        document.addEventListener("keydown", this._keydownHandler);
    }

    /**
     * Refreshes all dynamic elements
     */
    async refresh() {
        await this._drawContent();
    }

    /**
     * Hides the FlashcardView if it is visible
     */
    hide() {
        // Prevents the rest of code, from running if this was executed multiple times after one another
        if (this.view.hasClass("sr-is-hidden")) {
            return;
        }

        document.removeEventListener("keydown", this._keydownHandler);
        this.view.addClass("sr-is-hidden");
    }

    /**
     * Closes the FlashcardView
     */
    close() {
        this._stopCurrentAudio();
        this.hide();
        document.removeEventListener("keydown", this._keydownHandler);

        // Clear redo lists on session close
        this.reviewSequencer.clearRedoLists();
    }

    // #region -> Functions & helpers

    private async _drawContent() {
        // Pollution: prioritize getting card from redoCardList (peek)
        const cardData = this._getCardData();

        // Update current deck info
        this.mode = FlashcardMode.Front;
        this.previousDeck = this.currentDeck;
        this.currentDeck = this.reviewSequencer.currentDeck;
        if (this.previousDeck !== this.currentDeck) {
            const currentDeckStats = this.reviewSequencer.getDeckStats(
                this.currentDeck.getTopicPath(),
            );
            this.currentDeckTotalCardsInQueue = currentDeckStats.cardsInQueueOfThisDeckCount;
        }

        this._updateInfoBar(this.chosenDeck, this.currentDeck);

        // Update card content
        this.content.empty();
        const wrapper: RenderMarkdownWrapper = new RenderMarkdownWrapper(
            this.app,
            this.plugin,
            cardData.note.filePath,
        );

        const questionContent = this._createCardSection(
            "sr-card-question",
            "Copy question",
            async () => {
                const content = this._formatQuestionContent(cardData.card);
                await this._copyToClipboard(content, "Copied question");
            },
        );

        await wrapper.renderMarkdownWrapper(
            cardData.card.front.trimStart(),
            questionContent,
            cardData.question.questionText.textDirection,
        );

        // Set loop property for the specified audio index based on settings
        this._setAudioLoopProperty(
            this.content,
            this.settings.audioIndexOnFront,
            this.settings.loopAudioOnFront,
        );

        // Auto-play audio in front card
        this._stopCurrentAudio();
        if (this.settings.autoPlayAudioOnFront) {
            this._autoplayAudio(
                this.content,
                this.settings.audioIndexOnFront,
                this.settings.loopAudioOnFront,
            );
        }

        // Set scroll position back to top
        this.content.scrollTop = 0;

        // Update response buttons
        this._resetResponseButtons();

        // Update Redo button state
        this.redoButton.disabled = !this.reviewSequencer.canRedo();
    }

    /**
     * Pollution function: prioritize getting card from redoCardList (peek, returns copy)
     */
    private _getCardData(): {
        card: Card;
        question: Question;
        note: Note;
    } {
        const redoCard = this.reviewSequencer.peekRedoCard();
        if (redoCard) {
            return {
                card: redoCard.card,
                question: redoCard.question,
                note: redoCard.question.note,
            };
        }

        // Follow original sequencer flow
        return {
            card: this._currentCard,
            question: this._currentQuestion,
            note: this._currentNote,
        };
    }

    private get _currentCard(): Card {
        return this.reviewSequencer.currentCard;
    }

    private get _currentQuestion(): Question {
        return this.reviewSequencer.currentQuestion;
    }

    private get _currentNote(): Note {
        return this.reviewSequencer.currentNote;
    }

    private async _processReview(response: ReviewResponse): Promise<void> {
        const timeNow = now();
        if (
            this.lastPressed &&
            timeNow - this.lastPressed < this.plugin.data.settings.reviewButtonDelay
        ) {
            return;
        }
        this.lastPressed = timeNow;

        await this.reviewSequencer.processReview(response);
        await this._showNextCard();
    }

    private async _showNextCard(): Promise<void> {
        if (this._currentCard != null) await this.refresh();
        else this.backToDeck();
    }

    private async _processRedo(): Promise<void> {
        if (!this.reviewSequencer.canRedo()) return;

        await this.reviewSequencer.processRedo();
        await this._showNextCard();
    }

    // #region -> Controls

    private _createCardControls() {
        this._createEditButton();
        this._createCopyButton();
        this._createRedoButton();
        this._createResetButton();
        this._createCardInfoButton();
        this._createSkipButton();
    }

    private _createEditButton() {
        this.editButton = this.controls.createEl("button");
        this.editButton.addClasses(["sr-button", "sr-edit-button"]);
        setIcon(this.editButton, "edit");
        this.editButton.setAttribute("aria-label", t("EDIT_CARD"));
        this.editButton.addEventListener("click", () => {
            this.editClickHandler();
        });
    }

    private _createCopyButton() {
        this.copyButton = this.controls.createEl("button");
        this.copyButton.addClasses(["sr-button", "sr-copy-button"]);
        setIcon(this.copyButton, "copy");
        this.copyButton.setAttribute("aria-label", "Copy card content");
        this.copyButton.addEventListener("click", async () => {
            const cardData = this._getCardData();
            const content = this._formatFullCardContent(cardData.card);
            await this._copyToClipboard(content, "Copied card content");
        });
    }

    private _createResetButton() {
        this.resetButton = this.controls.createEl("button");
        this.resetButton.addClasses(["sr-button", "sr-reset-button"]);
        setIcon(this.resetButton, "refresh-cw");
        this.resetButton.setAttribute("aria-label", t("RESET_CARD_PROGRESS"));
        this.resetButton.disabled = true;
        this.resetButton.addEventListener("click", async () => {
            await this._processReview(ReviewResponse.Reset);
        });
    }

    private _createRedoButton() {
        this.redoButton = this.controls.createEl("button");
        this.redoButton.addClasses(["sr-button", "sr-redo-button"]);
        setIcon(this.redoButton, "undo-2");
        this.redoButton.setAttribute("aria-label", t("UNDO_LAST_REVIEW"));
        this.redoButton.disabled = true;
        this.redoButton.addEventListener("click", async () => {
            await this._processRedo();
        });
    }

    private _createCardInfoButton() {
        this.infoButton = this.controls.createEl("button");
        this.infoButton.addClasses(["sr-button", "sr-info-button"]);
        setIcon(this.infoButton, "info");
        this.infoButton.setAttribute("aria-label", "View Card Info");
        this.infoButton.addEventListener("click", async () => {
            this._displayCurrentCardInfoNotice();
        });
    }

    private _createSkipButton() {
        this.skipButton = this.controls.createEl("button");
        this.skipButton.addClasses(["sr-button", "sr-skip-button"]);
        setIcon(this.skipButton, "chevrons-right");
        this.skipButton.setAttribute("aria-label", t("SKIP"));
        this.skipButton.addEventListener("click", () => {
            this._skipCurrentCard();
        });
    }

    private async _skipCurrentCard(): Promise<void> {
        this.reviewSequencer.skipCurrentCard();
        await this._showNextCard();
    }

    private _createQuickAppendButtons() {
        const btn1Content = this.settings.quickAppendCardToFileBtn.trim();
        const btn2Content = this.settings.quickAppendContentBtn.trim();

        // QAdd1
        if (btn1Content !== "") {
            this.qCopyToFileButton = this.quickAppendControls.createEl("button");
            this.qCopyToFileButton.addClasses(["sr-button", "sr-quick-append-button"]);
            this.qCopyToFileButton.setText(btn1Content);
            this.qCopyToFileButton.setAttribute("aria-label", `Quick Add: ${btn1Content}`);
            this.qCopyToFileButton.addEventListener("click", async () => {
                if (this.settings.targetAppendFilePath) {
                    await this._appendCurrentContentToUserDefinedFile();
                }
            });
        }

        // QAdd2
        if (btn2Content !== "") {
            this.qAddContentButton = this.quickAppendControls.createEl("button");
            this.qAddContentButton.addClasses(["sr-button", "sr-quick-append-button"]);
            this.qAddContentButton.setText(btn2Content);
            this.qAddContentButton.setAttribute("aria-label", `Quick Add: ${btn2Content}`);
            this.qAddContentButton.addEventListener("click", async () => {
                await this._quickAppendContent(this.settings.quickAppendContentBtn);
            });
        }

        // 如果兩個都沒有，隱藏整個 controls row
        if (btn1Content === "" && btn2Content === "") {
            this.quickAppendControls.addClass("sr-is-hidden");
        }
    }

    private async _quickAppendContent(content: string): Promise<void> {
        try {
            const currentQ: Question = this._currentQuestion;

            // 取得原始文字
            const originalText = currentQ.questionText.actualQuestion;

            // 在尾端加內容
            const modifiedText = originalText.trimEnd() + content;

            // 更新
            await this.reviewSequencer.updateCurrentQuestionText(modifiedText);

            // 顯示成功回饋
            new Notice(`Appended: ${content}`);
        } catch (error) {
            // 錯誤處理
            new Notice("Failed to append content");
            console.error("Quick append error:", error);
        }
    }

    private async _appendCurrentContentToUserDefinedFile(): Promise<void> {
        try {
            await this.reviewSequencer.appendCurrentQuestionToUserDefinedFile();
            new Notice("Content copied to target file");
        } catch (error) {
            new Notice("Failed to copy content");
            console.error("Append to file error:", error);
        }
    }

    private _displayCurrentCardInfoNotice() {
        // Use _getCardData to ensure we get the correct card (Redo vs Current)
        const cardData = this._getCardData();
        const schedule = cardData.card.scheduleInfo;

        const currentEaseStr = t("CURRENT_EASE_HELP_TEXT") + (schedule?.latestEase ?? t("NEW"));
        const currentIntervalStr =
            t("CURRENT_INTERVAL_HELP_TEXT") + textInterval(schedule?.interval, false);
        const generatedFromStr = t("CARD_GENERATED_FROM", {
            notePath: cardData.note.filePath,
        });

        new Notice(currentEaseStr + "\n" + currentIntervalStr + "\n" + generatedFromStr);
    }

    // #region -> Deck Info

    private _createInfoSection() {
        this.infoSection = this.view.createDiv();
        this.infoSection.addClass("sr-info-section");

        this.deckProgressInfo = this.infoSection.createDiv();
        this.deckProgressInfo.addClass("sr-deck-progress-info");

        this.chosenDeckInfo = this.deckProgressInfo.createDiv();
        this.chosenDeckInfo.addClass("sr-chosen-deck-info");
        this.chosenDeckName = this.chosenDeckInfo.createDiv();
        this.chosenDeckName.addClass("sr-chosen-deck-name");

        this.chosenDeckCounterWrapper = this.chosenDeckInfo.createDiv();
        this.chosenDeckCounterWrapper.addClass("sr-chosen-deck-counter-wrapper");

        this.chosenDeckCounterDivider = this.chosenDeckCounterWrapper.createDiv();
        this.chosenDeckCounterDivider.addClass("sr-chosen-deck-counter-divider");

        this.chosenDeckCardCounterWrapper = this.chosenDeckCounterWrapper.createDiv();
        this.chosenDeckCardCounterWrapper.addClass("sr-chosen-deck-card-counter-wrapper");

        this.chosenDeckCardCounter = this.chosenDeckCardCounterWrapper.createDiv();
        this.chosenDeckCardCounter.addClass("sr-chosen-deck-card-counter");

        this.chosenDeckCardCounterIcon = this.chosenDeckCardCounterWrapper.createDiv();
        this.chosenDeckCardCounterIcon.addClass("sr-chosen-deck-card-counter-icon");
        setIcon(this.chosenDeckCardCounterIcon, "credit-card");

        this.chosenDeckSubDeckCounterWrapper = this.chosenDeckCounterWrapper.createDiv();
        this.chosenDeckSubDeckCounterWrapper.addClass("sr-is-hidden");
        this.chosenDeckSubDeckCounterWrapper.addClass("sr-chosen-deck-subdeck-counter-wrapper");

        this.chosenDeckSubDeckCounter = this.chosenDeckSubDeckCounterWrapper.createDiv();
        this.chosenDeckSubDeckCounter.addClass("sr-chosen-deck-subdeck-counter");

        this.chosenDeckSubDeckCounterIcon = this.chosenDeckSubDeckCounterWrapper.createDiv();
        this.chosenDeckSubDeckCounterIcon.addClass("sr-chosen-deck-subdeck-counter-icon");
        setIcon(this.chosenDeckSubDeckCounterIcon, "layers");

        this.currentDeckInfo = this.deckProgressInfo.createDiv();
        this.currentDeckInfo.addClass("sr-is-hidden");
        this.currentDeckInfo.addClass("sr-current-deck-info");

        this.currentDeckName = this.currentDeckInfo.createDiv();
        this.currentDeckName.addClass("sr-current-deck-name");

        this.currentDeckCounterWrapper = this.currentDeckInfo.createDiv();
        this.currentDeckCounterWrapper.addClass("sr-current-deck-counter-wrapper");

        this.currentDeckCounterDivider = this.currentDeckCounterWrapper.createDiv();
        this.currentDeckCounterDivider.addClass("sr-current-deck-counter-divider");

        this.currentDeckCardCounterWrapper = this.currentDeckCounterWrapper.createDiv();
        this.currentDeckCardCounterWrapper.addClass("sr-current-deck-card-counter-wrapper");

        this.currentDeckCardCounter = this.currentDeckCardCounterWrapper.createDiv();
        this.currentDeckCardCounter.addClass("sr-current-deck-card-counter");
        this.currentDeckCardCounterIcon = this.currentDeckCardCounterWrapper.createDiv();
        this.currentDeckCardCounterIcon.addClass("sr-current-deck-card-counter-icon");
        setIcon(this.currentDeckCardCounterIcon, "credit-card");

        if (this.settings.showContextInCards) {
            this.cardContext = this.infoSection.createDiv();
            this.cardContext.addClass("sr-context");
        }
    }

    private _updateInfoBar(chosenDeck: Deck, currentDeck: Deck) {
        this._updateChosenDeckInfo(chosenDeck);
        this._updateCurrentDeckInfo(chosenDeck, currentDeck);
        this._updateCardContext();
    }

    private _updateChosenDeckInfo(chosenDeck: Deck) {
        const chosenDeckStats = this.reviewSequencer.getDeckStats(chosenDeck.getTopicPath());

        this.chosenDeckName.setText(`${chosenDeck.deckName}`);

        // Pollution: include redo card count in total cards
        const redoCount = this.reviewSequencer.getRedoCardCount();
        const completed = this.totalCardsInSession - chosenDeckStats.cardsInQueueCount - redoCount;
        const total = this.totalCardsInSession;
        this.chosenDeckCardCounter.setText(`${completed}/${total}`);

        if (chosenDeck.subdecks.length === 0) {
            if (!this.chosenDeckSubDeckCounterWrapper.hasClass("sr-is-hidden")) {
                this.chosenDeckSubDeckCounterWrapper.addClass("sr-is-hidden");
            }
            return;
        }

        if (this.chosenDeckSubDeckCounterWrapper.hasClass("sr-is-hidden")) {
            this.chosenDeckSubDeckCounterWrapper.removeClass("sr-is-hidden");
        }

        this.chosenDeckSubDeckCounter.setText(
            `${this.totalDecksInSession - chosenDeckStats.decksInQueueOfThisDeckCount}/${this.totalDecksInSession}`,
        );
    }

    private _updateCurrentDeckInfo(chosenDeck: Deck, currentDeck: Deck) {
        if (chosenDeck.subdecks.length === 0) {
            if (!this.currentDeckInfo.hasClass("sr-is-hidden")) {
                this.currentDeckInfo.addClass("sr-is-hidden");
            }
            return;
        }

        if (this.currentDeckInfo.hasClass("sr-is-hidden")) {
            this.currentDeckInfo.removeClass("sr-is-hidden");
        }

        this.currentDeckName.setText(`${currentDeck.deckName}`);

        const isRandomMode = this.settings.flashcardCardOrder === "EveryCardRandomDeckAndCard";
        if (!isRandomMode) {
            const currentDeckStats = this.reviewSequencer.getDeckStats(currentDeck.getTopicPath());

            // Pollution: include redo card count in current deck total
            const redoCount = this.reviewSequencer.getRedoCardCount();
            const completed =
                this.currentDeckTotalCardsInQueue -
                currentDeckStats.cardsInQueueOfThisDeckCount -
                redoCount;
            const total = this.currentDeckTotalCardsInQueue;
            this.currentDeckCardCounter.setText(`${completed}/${total}`);
        }
    }

    private _updateCardContext() {
        if (!this.settings.showContextInCards) {
            this.cardContext.setText("");
            return;
        }
        this.cardContext.setText(
            ` ${this._formatQuestionContextText(this._currentQuestion.questionContext)}`,
        );
    }

    private _formatQuestionContextText(questionContext: string[]): string {
        const separator: string = " > ";
        let result = this._currentNote.file.basename;
        questionContext.forEach((context) => {
            // Check for links trim [[ ]]
            if (context.startsWith("[[") && context.endsWith("]]")) {
                context = context.replace("[[", "").replace("]]", "");
                // Use replacement text if any
                if (context.contains("|")) {
                    context = context.split("|")[1];
                }
            }
            result += separator + context;
        });
        return result;
    }

    // #region -> Response

    private _createResponseButtons() {
        this._createShowAnswerButton();
        this._createHardButton();
        this._createGoodButton();
        this._createEasyButton();
    }

    private _resetResponseButtons() {
        // Sets all buttons in to their default state
        this.answerButton.removeClass("sr-is-hidden");
        this.hardButton.addClass("sr-is-hidden");
        this.goodButton.addClass("sr-is-hidden");
        this.easyButton.addClass("sr-is-hidden");
        this.resetButton.disabled = true;
    }

    private _createShowAnswerButton() {
        this.answerButton = this.response.createEl("button");
        this.answerButton.addClasses(["sr-response-button", "sr-show-answer-button", "sr-bg-blue"]);
        this.answerButton.setText(t("SHOW_ANSWER"));
        this.answerButton.addEventListener("click", () => {
            this._showAnswer();
        });
    }

    private _createHardButton() {
        this.hardButton = this.response.createEl("button");
        this.hardButton.addClasses([
            "sr-response-button",
            "sr-hard-button",
            "sr-bg-red",
            "sr-is-hidden",
        ]);
        this.hardButton.setText(this.settings.flashcardHardText);
        this.hardButton.addEventListener("click", () => {
            this._processReview(ReviewResponse.Hard);
        });
    }

    private _createGoodButton() {
        this.goodButton = this.response.createEl("button");
        this.goodButton.addClasses([
            "sr-response-button",
            "sr-good-button",
            "sr-bg-blue",
            "sr-is-hidden",
        ]);
        this.goodButton.setText(this.settings.flashcardGoodText);
        this.goodButton.addEventListener("click", () => {
            this._processReview(ReviewResponse.Good);
        });
    }

    private _createEasyButton() {
        this.easyButton = this.response.createEl("button");
        this.easyButton.addClasses([
            "sr-response-button",
            "sr-hard-button",
            "sr-bg-green",
            "sr-is-hidden",
        ]);
        this.easyButton.setText(this.settings.flashcardEasyText);
        this.easyButton.addEventListener("click", () => {
            this._processReview(ReviewResponse.Easy);
        });
    }

    private _setupEaseButton(
        button: HTMLElement,
        buttonName: string,
        reviewResponse: ReviewResponse,
    ) {
        const schedule: RepItemScheduleInfo = this.reviewSequencer.determineCardSchedule(
            reviewResponse,
            this._currentCard,
        );
        const interval: number = schedule.interval;

        if (this.settings.showIntervalInReviewButtons) {
            if (Platform.isMobile) {
                button.setText(textInterval(interval, true));
            } else {
                button.setText(`${buttonName} - ${textInterval(interval, false)}`);
            }
        } else {
            button.setText(buttonName);
        }
    }

    private _showAnswer(): void {
        const timeNow = now();
        if (
            this.lastPressed &&
            timeNow - this.lastPressed < this.plugin.data.settings.reviewButtonDelay
        ) {
            return;
        }
        this.lastPressed = timeNow;

        this.mode = FlashcardMode.Back;

        // Pollution: prioritize getting card from redoCardList (peek)
        const cardData = this._getCardData();

        // Show answer text
        if (cardData.question.questionType !== CardType.Cloze) {
            const hr: HTMLElement = document.createElement("hr");
            this.content.appendChild(hr);
        } else {
            this.content.empty();
        }

        const wrapper: RenderMarkdownWrapper = new RenderMarkdownWrapper(
            this.app,
            this.plugin,
            cardData.note.filePath,
        );

        const answerContent = this._createCardSection("sr-card-answer", "Copy answer", async () => {
            const content = this._formatAnswerContent(cardData.card);
            await this._copyToClipboard(content, "Copied answer");
        });

        wrapper.renderMarkdownWrapper(
            cardData.card.back,
            answerContent,
            cardData.question.questionText.textDirection,
        );

        // Set loop property for both front and back audio elements
        // For non-cloze cards: front audio persists, so we need to maintain its loop setting
        // For cloze cards: content is cleared, so we only have back audio
        if (cardData.question.questionType !== CardType.Cloze) {
            // Non-cloze: set loop for both front and back audio
            this._setAudioLoopProperty(
                this.content,
                this.settings.audioIndexOnFront,
                this.settings.loopAudioOnFront,
            );
            this._setAudioLoopProperty(
                this.content,
                this.settings.audioIndexOnBack,
                this.settings.loopAudioOnBack,
            );
        } else {
            // Cloze: only set loop for back audio (front is cleared)
            this._setAudioLoopProperty(
                this.content,
                this.settings.audioIndexOnBack,
                this.settings.loopAudioOnBack,
            );
        }

        // Auto-play audio in back card
        this._stopCurrentAudio();
        if (this.settings.autoPlayAudioOnBack) {
            this._autoplayAudio(
                this.content,
                this.settings.audioIndexOnBack,
                this.settings.loopAudioOnBack,
            );
        }

        // Show response buttons
        this.answerButton.addClass("sr-is-hidden");
        this.resetButton.disabled = false;
        this.hardButton.removeClass("sr-is-hidden");
        this.easyButton.removeClass("sr-is-hidden");

        if (this.reviewMode === FlashcardReviewMode.Cram) {
            this.response.addClass("is-cram");
            this.hardButton.setText(`${this.settings.flashcardHardText}`);
            this.easyButton.setText(`${this.settings.flashcardEasyText}`);
        } else {
            this.goodButton.removeClass("sr-is-hidden");
            this._setupEaseButton(
                this.hardButton,
                this.settings.flashcardHardText,
                ReviewResponse.Hard,
            );
            this._setupEaseButton(
                this.goodButton,
                this.settings.flashcardGoodText,
                ReviewResponse.Good,
            );
            this._setupEaseButton(
                this.easyButton,
                this.settings.flashcardEasyText,
                ReviewResponse.Easy,
            );
        }
    }

    /**
     * Set loop property for audio element at specified index
     * @param container - The HTML container to search for audio elements
     * @param index - The index of audio element to set loop property (0-3)
     * @param loop - Whether to enable loop for the specified audio element
     */
    private _setAudioLoopProperty(container: HTMLElement, index: number, loop: boolean): void {
        // Delay execution to wait for Obsidian's markdown rendering to complete
        setTimeout(() => {
            const audioElements = container.querySelectorAll("audio");
            if (audioElements.length > index) {
                (audioElements[index] as HTMLAudioElement).loop = loop;
            }
        }, 100); // Small delay to ensure audio elements are rendered
    }

    /**
     * Auto-play audio element at specified index
     * @param container - The HTML container to search for audio elements
     * @param index - The index of audio element to play (0-3)
     * @param loop - Whether to loop the audio
     */
    private _autoplayAudio(container: HTMLElement, index: number, loop: boolean = false): void {
        // Delay execution to wait for Obsidian's markdown rendering to complete
        setTimeout(() => {
            const audioElements = container.querySelectorAll("audio");

            if (audioElements.length > index) {
                const audio = audioElements[index] as HTMLAudioElement;
                audio.loop = loop;
                this.currentAudio = audio;
                audio.play().catch((error) => {
                    // Silent handling if autoplay fails
                    console.debug("Audio autoplay failed:", error);
                });
            }
        }, 150); // 150ms delay for rendering engine
    }

    /**
     * Stop currently playing audio
     */
    private _stopCurrentAudio(): void {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
            this.currentAudio = null;
        }
    }

    private _createCardSection(
        sectionClass: string,
        copyAriaLabel: string,
        onCopy: () => void | Promise<void>,
    ): HTMLDivElement {
        const section = this.content.createDiv();
        section.addClasses(["sr-card-section", sectionClass]);

        const actions = section.createDiv();
        actions.addClass("sr-card-section-actions");

        const copyButton = actions.createEl("button");
        copyButton.addClasses(["sr-button", "sr-card-copy-button"]);
        setIcon(copyButton, "copy");
        copyButton.setAttribute("aria-label", copyAriaLabel);
        copyButton.addEventListener("click", () => {
            onCopy();
        });

        const content = section.createDiv();
        content.addClass("sr-card-section-content");

        return content;
    }

    private _formatQuestionContent(card: Card): string {
        return (card.front ?? "").trim();
    }

    private _formatAnswerContent(card: Card): string {
        return (card.back ?? "").trim();
    }

    private _formatFullCardContent(card: Card): string {
        const front = this._formatQuestionContent(card);
        const back = this._formatAnswerContent(card);
        if (front && back) {
            return `${front}\n\n---\n\n${back}`;
        }
        return front || back;
    }

    private async _copyToClipboard(text: string, successMessage: string): Promise<void> {
        if (!text || text.trim().length === 0) {
            new Notice("No content to copy");
            return;
        }

        try {
            if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const textArea = document.createElement("textarea");
                textArea.value = text;
                textArea.style.position = "fixed";
                textArea.style.opacity = "0";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand("copy");
                document.body.removeChild(textArea);
            }
            new Notice(successMessage);
        } catch (error) {
            new Notice("Failed to copy to clipboard");
            console.error("Copy error:", error);
        }
    }

    private _keydownHandler = (e: KeyboardEvent) => {
        // Prevents any input, if the edit modal is open or if the view is not in focus
        if (
            document.activeElement.nodeName === "TEXTAREA" ||
            this.mode === FlashcardMode.Closed ||
            !this.plugin.getSRInFocusState()
        ) {
            return;
        }

        const consumeKeyEvent = () => {
            e.preventDefault();
            e.stopPropagation();
        };

        switch (e.code) {
            case "KeyS":
                this._skipCurrentCard();
                consumeKeyEvent();
                break;
            case "Space":
                if (this.mode === FlashcardMode.Front) {
                    this._showAnswer();
                    consumeKeyEvent();
                } else if (this.mode === FlashcardMode.Back) {
                    this._processReview(ReviewResponse.Good);
                    consumeKeyEvent();
                }
                break;
            case "Enter":
            case "NumpadEnter":
                if (this.mode !== FlashcardMode.Front) {
                    break;
                }
                this._showAnswer();
                consumeKeyEvent();
                break;
            case "Numpad1":
            case "Digit1":
                if (this.mode !== FlashcardMode.Back) {
                    break;
                }
                this._processReview(ReviewResponse.Hard);
                consumeKeyEvent();
                break;
            case "Numpad2":
            case "Digit2":
                if (this.mode !== FlashcardMode.Back) {
                    break;
                }
                this._processReview(ReviewResponse.Good);
                consumeKeyEvent();
                break;
            case "Numpad3":
            case "Digit3":
                if (this.mode !== FlashcardMode.Back) {
                    break;
                }
                this._processReview(ReviewResponse.Easy);
                consumeKeyEvent();
                break;
            case "Numpad0":
            case "Digit0":
                if (this.mode !== FlashcardMode.Back) {
                    break;
                }
                this._processReview(ReviewResponse.Reset);
                consumeKeyEvent();
                break;
            case "KeyZ":
                if ((e.ctrlKey || e.metaKey) && this.reviewSequencer.canRedo()) {
                    this._processRedo();
                    consumeKeyEvent();
                }
                break;
            default:
                break;
        }
    };
}
