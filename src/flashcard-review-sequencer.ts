import { ISrsAlgorithm } from "src/algorithms/base/isrs-algorithm";
import { RepItemScheduleInfo } from "src/algorithms/base/rep-item-schedule-info";
import { ReviewResponse } from "src/algorithms/base/repetition-item";
import { Card } from "src/card";
import { TICKS_PER_DAY } from "src/constants";
import { DataStore } from "src/data-stores/base/data-store";
import { CardListType, Deck } from "src/deck";
import { IDeckTreeIterator } from "src/deck-tree-iterator";
import { DueDateHistogram } from "src/due-date-histogram";
import { Note } from "src/note";
import { Question, QuestionText } from "src/question";
import { IQuestionPostponementList } from "src/question-postponement-list";
import { CardFrontBackUtil } from "src/question-type";
import { SRSettings } from "src/settings";
import { TopicPath } from "src/topic-path";
import { globalDateProvider } from "src/utils/dates";
import { deepClone } from "src/utils/types";

/**
 * Data structure for storing undo information about a reviewed card.
 */
export interface ReviewUndoData {
    card: Card;
    question: Question;
    hadScheduleBeforeReview: boolean;
    oldScheduleInfo: RepItemScheduleInfo | null;
}

export interface IFlashcardReviewSequencer {
    get hasCurrentCard(): boolean;
    get currentCard(): Card;
    get currentQuestion(): Question;
    get currentNote(): Note;
    get currentDeck(): Deck;
    get originalDeckTree(): Deck;

    setDeckTree(originalDeckTree: Deck, remainingDeckTree: Deck): void;
    setCurrentDeck(topicPath: TopicPath): void;
    getDeckStats(topicPath: TopicPath): DeckStats;
    getSubDecksWithCardsInQueue(deck: Deck): Deck[];
    skipCurrentCard(): void;
    determineCardSchedule(response: ReviewResponse, card: Card): RepItemScheduleInfo;
    processReview(response: ReviewResponse): Promise<void>;
    updateCurrentQuestionText(text: string): Promise<void>;
    appendCurrentQuestionToUserDefinedFile(): Promise<void>;

    // Redo functionality
    canRedo(): boolean;
    peekRedoCard(): { card: Card; question: Question } | null;
    getRedoCardCount(): number;
    processRedo(): Promise<void>;
    clearRedoLists(): void;
}

/**
 * Represents statistics for a deck and its subdecks.
 *
 * @property {number} totalCount - Total number of cards in this deck and all subdecks.
 * @property {number} dueCount - Number of due cards in this deck and all subdecks.
 * @property {number} newCount - Number of new cards in this deck and all subdecks.
 * @property {number} cardsInQueueCount - Number of cards in the queue of this deck and all subdecks.
 * @property {number} dueCardsInQueueOfThisDeckCount - Number of due cards just in this deck.
 * @property {number} newCardsInQueueOfThisDeckCount - Number of new cards just in this deck.
 * @property {number} cardsInQueueOfThisDeckCount - Total number of cards in queue just in this deck.
 * @property {number} subDecksInQueueOfThisDeckCount - Number of subdecks in the queue just in this deck.
 * @property {number} decksInQueueOfThisDeckCount - Total number of decks in the queue including this deck and its subdecks.
 *
 * @constructor
 * @param {number} totalCount - Initializes the total count of cards.
 * @param {number} dueCount - Initializes the due count of cards.
 * @param {number} newCount - Initializes the new count of cards.
 * @param {number} cardsInQueueCount - Initializes the count of cards in the queue.
 * @param {number} dueCardsInQueueOfThisDeckCount - Initializes the count of due cards just in this deck.
 * @param {number} newCardsInQueueOfThisDeckCount - Initializes the count of new cards just in this deck.
 * @param {number} cardsInQueueOfThisDeckCount - Initializes the count of all cards in the queue just in this deck.
 * @param {number} subDecksInQueueOfThisDeckCount - Initializes the count of subdecks in the queue just in this deck.
 * @param {number} decksInQueueOfThisDeckCount - Initializes the count of all decks in the queue including this deck and its subdecks.
 */
export class DeckStats {
    totalCount: number;
    dueCount: number;
    newCount: number;
    cardsInQueueCount: number;
    dueCardsInQueueOfThisDeckCount: number;
    newCardsInQueueOfThisDeckCount: number;
    cardsInQueueOfThisDeckCount: number;
    subDecksInQueueOfThisDeckCount: number;
    decksInQueueOfThisDeckCount: number;

    constructor(
        totalCount: number,
        dueCount: number,
        newCount: number,
        cardsInQueueCount: number,
        dueCardsInQueueOfThisDeckCount: number,
        newCardsInQueueOfThisDeckCount: number,
        cardsInQueueOfThisDeckCount: number,
        subDecksInQueueOfThisDeckCount: number,
        decksInQueueOfThisDeckCount: number,
    ) {
        this.dueCount = dueCount;
        this.newCount = newCount;
        this.totalCount = totalCount;
        this.cardsInQueueCount = cardsInQueueCount;
        this.dueCardsInQueueOfThisDeckCount = dueCardsInQueueOfThisDeckCount;
        this.newCardsInQueueOfThisDeckCount = newCardsInQueueOfThisDeckCount;
        this.cardsInQueueOfThisDeckCount = cardsInQueueOfThisDeckCount;
        this.subDecksInQueueOfThisDeckCount = subDecksInQueueOfThisDeckCount;
        this.decksInQueueOfThisDeckCount = decksInQueueOfThisDeckCount;
    }
}

export enum FlashcardReviewMode {
    Cram,
    Review,
}

export class FlashcardReviewSequencer implements IFlashcardReviewSequencer {
    // We need the original deck tree so that we can still provide the total cards in each deck
    private _originalDeckTree: Deck;

    // This is set by the caller, and must have the same deck hierarchy as originalDeckTree.
    private remainingDeckTree: Deck;

    private reviewMode: FlashcardReviewMode;
    private cardSequencer: IDeckTreeIterator;
    private settings: SRSettings;
    private srsAlgorithm: ISrsAlgorithm;
    private questionPostponementList: IQuestionPostponementList;
    private dueDateFlashcardHistogram: DueDateHistogram;

    // Redo functionality: stores reviewed cards for undo
    private reviewedCardList: ReviewUndoData[] = [];
    // Redo functionality: stores cards that have been undone for redo display
    private redoCardList: ReviewUndoData[] = [];

    constructor(
        reviewMode: FlashcardReviewMode,
        cardSequencer: IDeckTreeIterator,
        settings: SRSettings,
        srsAlgorithm: ISrsAlgorithm,
        questionPostponementList: IQuestionPostponementList,
        dueDateFlashcardHistogram: DueDateHistogram,
    ) {
        this.reviewMode = reviewMode;
        this.cardSequencer = cardSequencer;
        this.settings = settings;
        this.srsAlgorithm = srsAlgorithm;
        this.questionPostponementList = questionPostponementList;
        this.dueDateFlashcardHistogram = dueDateFlashcardHistogram;
    }

    get hasCurrentCard(): boolean {
        return this.cardSequencer.currentCard != null;
    }

    get currentCard(): Card {
        return this.cardSequencer.currentCard;
    }

    get currentQuestion(): Question {
        return this.currentCard?.question;
    }

    get currentDeck(): Deck {
        return this.cardSequencer.currentDeck;
    }

    get currentNote(): Note {
        return this.currentQuestion.note;
    }

    // originalDeckTree isn't modified by the review process
    // Only remainingDeckTree
    setDeckTree(originalDeckTree: Deck, remainingDeckTree: Deck): void {
        this.cardSequencer.setBaseDeck(remainingDeckTree);
        this._originalDeckTree = originalDeckTree;
        this.remainingDeckTree = remainingDeckTree;
        this.setCurrentDeck(TopicPath.emptyPath);
    }

    setCurrentDeck(topicPath: TopicPath): void {
        this.cardSequencer.setIteratorTopicPath(topicPath);
        this.cardSequencer.nextCard();
    }

    get originalDeckTree(): Deck {
        return this._originalDeckTree;
    }

    getDeckStats(topicPath: TopicPath): DeckStats {
        const totalCount: number = this._originalDeckTree
            .getDeck(topicPath)
            .getDistinctCardCount(CardListType.All, true);
        const remainingDeck: Deck = this.remainingDeckTree.getDeck(topicPath);
        const newCount: number = remainingDeck.getDistinctCardCount(CardListType.NewCard, true);
        const dueCount: number = remainingDeck.getDistinctCardCount(CardListType.DueCard, true);

        // Sry for the long variable names, but I needed all these distinct counts in the UI
        const newCardsInQueueOfThisDeckCount = remainingDeck.getDistinctCardCount(
            CardListType.NewCard,
            false,
        );
        const dueCardsInQueueOfThisDeckCount = remainingDeck.getDistinctCardCount(
            CardListType.DueCard,
            false,
        );
        const cardsInQueueOfThisDeckCount =
            newCardsInQueueOfThisDeckCount + dueCardsInQueueOfThisDeckCount;

        const subDecksInQueueOfThisDeckCount =
            this.getSubDecksWithCardsInQueue(remainingDeck).length;
        const decksInQueueOfThisDeckCount =
            cardsInQueueOfThisDeckCount > 0
                ? subDecksInQueueOfThisDeckCount + 1
                : subDecksInQueueOfThisDeckCount;

        return new DeckStats(
            totalCount,
            dueCount,
            newCount,
            dueCount + newCount,
            dueCardsInQueueOfThisDeckCount,
            newCardsInQueueOfThisDeckCount,
            cardsInQueueOfThisDeckCount,
            subDecksInQueueOfThisDeckCount,
            decksInQueueOfThisDeckCount,
        );
    }

    getSubDecksWithCardsInQueue(deck: Deck): Deck[] {
        let subDecksWithCardsInQueue: Deck[] = [];

        deck.subdecks.forEach((subDeck) => {
            subDecksWithCardsInQueue = subDecksWithCardsInQueue.concat(
                this.getSubDecksWithCardsInQueue(subDeck),
            );

            const newCount: number = subDeck.getDistinctCardCount(CardListType.NewCard, false);
            const dueCount: number = subDeck.getDistinctCardCount(CardListType.DueCard, false);
            if (newCount + dueCount > 0) subDecksWithCardsInQueue.push(subDeck);
        });

        return subDecksWithCardsInQueue;
    }

    skipCurrentCard(): void {
        if (this.redoCardList.length > 0) {
            this.redoCardList.pop();
            return;
        }
        this.cardSequencer.deleteCurrentQuestionFromAllDecks();
    }

    private deleteCurrentCard(): void {
        this.cardSequencer.deleteCurrentCardFromAllDecks();
    }

    async processReview(response: ReviewResponse): Promise<void> {
        // Check if processing a redo card
        if (this.redoCardList.length > 0) {
            // Pop redo card
            const redoCard = this.redoCardList.pop()!;

            switch (this.reviewMode) {
                case FlashcardReviewMode.Review: {
                    if (response === ReviewResponse.Reset) {
                        // For reset on redo card:
                        // 1. Calculate new schedule (New/Reset)
                        redoCard.card.scheduleInfo = this.srsAlgorithm.cardGetResetSchedule();
                        // 2. Write to file
                        await DataStore.getInstance().questionWriteSchedule(redoCard.question);
                        // 3. Push back to redo list (keep displayed for further action)
                        this.redoCardList.push(redoCard);
                        return;
                    }

                    // Backup old schedule (state before this review)
                    const oldScheduleInfo = redoCard.card.scheduleInfo
                        ? deepClone(redoCard.card.scheduleInfo)
                        : null;

                    // Calculate and write new schedule
                    redoCard.card.scheduleInfo = this.determineCardSchedule(
                        response,
                        redoCard.card,
                    );
                    await DataStore.getInstance().questionWriteSchedule(redoCard.question);

                    // Backup to reviewedCardList (store old schedule)
                    // Note: Store reference to card/question (circular reference issues)
                    this.reviewedCardList.push({
                        card: redoCard.card,
                        question: redoCard.question,
                        hadScheduleBeforeReview: true, // redo card always has schedule
                        oldScheduleInfo: oldScheduleInfo, // store old, not new!
                    });

                    // Return directly, don't go through normal flow
                    // UI layer's _showNextCard() will handle next card automatically
                    return;
                }
                case FlashcardReviewMode.Cram: {
                    // Cram mode doesn't write file, just pop
                    // UI layer's _showNextCard() will handle next card automatically
                    return;
                }
            }
        }

        // Normal flow: backup current card
        // Note: We store reference to card/question (not deep clone) because:
        // 1. Card/Question have circular references that can't be JSON cloned
        // 2. We only need to track the scheduleInfo for undo
        const oldScheduleInfo = this.currentCard.scheduleInfo
            ? deepClone(this.currentCard.scheduleInfo)
            : null;
        this.reviewedCardList.push({
            card: this.currentCard,
            question: this.currentQuestion,
            hadScheduleBeforeReview: this.currentCard.hasSchedule,
            oldScheduleInfo: oldScheduleInfo,
        });

        // Execute original logic
        switch (this.reviewMode) {
            case FlashcardReviewMode.Review:
                await this.processReviewReviewMode(response);
                break;

            case FlashcardReviewMode.Cram:
                await this.processReviewCramMode(response);
                break;
        }
    }

    async processReviewReviewMode(response: ReviewResponse): Promise<void> {
        if (response != ReviewResponse.Reset || this.currentCard.hasSchedule) {
            const oldSchedule = this.currentCard.scheduleInfo;

            // We need to update the schedule if:
            //  (1) the user reviewed with easy/good/hard (either a new or due card),
            //  (2) or reset a due card
            // Nothing to do if a user resets a new card
            this.currentCard.scheduleInfo = this.determineCardSchedule(response, this.currentCard);

            // Update the source file with the updated schedule
            await DataStore.getInstance().questionWriteSchedule(this.currentQuestion);

            if (oldSchedule) {
                const today: number = globalDateProvider.today.valueOf();
                const nDays: number = Math.ceil(
                    (oldSchedule.dueDateAsUnix - today) / TICKS_PER_DAY,
                );

                this.dueDateFlashcardHistogram.decrement(nDays);
            }
            this.dueDateFlashcardHistogram.increment(this.currentCard.scheduleInfo.interval);
        }

        // Move/delete the card
        if (response == ReviewResponse.Reset) {
            this.cardSequencer.moveCurrentCardToEndOfList();
            this.cardSequencer.nextCard();
        } else {
            if (this.settings.burySiblingCards) {
                await this.burySiblingCards();
                this.cardSequencer.deleteCurrentQuestionFromAllDecks();
            } else {
                this.deleteCurrentCard();
            }
        }
    }

    private async burySiblingCards(): Promise<void> {
        // We check if there are any sibling cards still in the deck,
        // We do this because otherwise we would be adding every reviewed card to the postponement list, even for a
        // question with a single card. That isn't consistent with the 1.10.1 behavior
        const remaining = this.currentDeck.getQuestionCardCount(this.currentQuestion);
        if (remaining > 1) {
            this.questionPostponementList.add(this.currentQuestion);
            await this.questionPostponementList.write();
        }
    }

    async processReviewCramMode(response: ReviewResponse): Promise<void> {
        if (response == ReviewResponse.Easy) this.deleteCurrentCard();
        else {
            this.cardSequencer.moveCurrentCardToEndOfList();
            this.cardSequencer.nextCard();
        }
    }

    determineCardSchedule(response: ReviewResponse, card: Card): RepItemScheduleInfo {
        let result: RepItemScheduleInfo;

        if (response == ReviewResponse.Reset) {
            // Resetting the card schedule
            result = this.srsAlgorithm.cardGetResetSchedule();
        } else {
            // scheduled card
            if (card.hasSchedule) {
                result = this.srsAlgorithm.cardCalcUpdatedSchedule(
                    response,
                    card.scheduleInfo,
                    this.dueDateFlashcardHistogram,
                );
            } else {
                const currentNote: Note = card.question.note;
                result = this.srsAlgorithm.cardGetNewSchedule(
                    response,
                    currentNote.filePath,
                    this.dueDateFlashcardHistogram,
                );
            }
        }
        return result;
    }

    async updateCurrentQuestionText(text: string): Promise<void> {
        if (this.redoCardList.length > 0) {
            const redoData = this.redoCardList[this.redoCardList.length - 1];
            const q = redoData.question.questionText;

            // Update question text
            q.actualQuestion = text;

            // Regenerate cards' front/back using CardFrontBackUtil
            const cardType = redoData.question.questionType;
            const newFrontBacks = CardFrontBackUtil.expand(cardType, text, this.settings);

            // Update existing cards' front/back (preserve schedule and other info)
            for (let i = 0; i < redoData.question.cards.length && i < newFrontBacks.length; i++) {
                redoData.question.cards[i].front = newFrontBacks[i].front;
                redoData.question.cards[i].back = newFrontBacks[i].back;
            }

            await DataStore.getInstance().questionWrite(redoData.question);
            return;
        }

        const q: QuestionText = this.currentQuestion.questionText;

        // Update question text
        q.actualQuestion = text;

        // Regenerate cards' front/back using CardFrontBackUtil
        // This ensures the card's cached content matches the updated question
        const cardType = this.currentQuestion.questionType;
        const newFrontBacks = CardFrontBackUtil.expand(cardType, text, this.settings);

        // Update existing cards' front/back (preserve schedule and other info)
        for (let i = 0; i < this.currentQuestion.cards.length && i < newFrontBacks.length; i++) {
            this.currentQuestion.cards[i].front = newFrontBacks[i].front;
            this.currentQuestion.cards[i].back = newFrontBacks[i].back;
        }

        await DataStore.getInstance().questionWrite(this.currentQuestion);
    }

    async appendCurrentQuestionToUserDefinedFile(): Promise<void> {
        await DataStore.getInstance().appendToTargetNote(
            this.currentQuestion.questionText.original,
        );
    }

    // #region Redo functionality

    /**
     * Check if redo is available (i.e., there are reviewed cards to undo)
     */
    canRedo(): boolean {
        return this.reviewedCardList.length > 0;
    }

    /**
     * Peek the top redo card (returns the card/question reference for display)
     * Note: Card/Question have circular references, so we return the reference directly
     */
    peekRedoCard(): { card: Card; question: Question } | null {
        if (this.redoCardList.length === 0) return null;

        const undoData = this.redoCardList[this.redoCardList.length - 1];
        return {
            card: undoData.card,
            question: undoData.question,
        };
    }

    /**
     * Get the count of redo cards
     */
    getRedoCardCount(): number {
        return this.redoCardList.length;
    }

    /**
     * Process redo: pop from reviewedCardList, restore old schedule, push to redoCardList
     */
    async processRedo(): Promise<void> {
        if (this.reviewedCardList.length === 0) return;

        // Pop the last reviewed card
        const undoData = this.reviewedCardList.pop()!;

        // Restore old schedule
        if (!undoData.hadScheduleBeforeReview) {
            undoData.card.scheduleInfo = null;
        } else {
            undoData.card.scheduleInfo = undoData.oldScheduleInfo;
        }

        // Write back to file
        await DataStore.getInstance().questionWriteSchedule(undoData.question);

        // Push to redoCardList
        this.redoCardList.push(undoData);
    }

    /**
     * Clear all redo lists (called when session ends)
     */
    clearRedoLists(): void {
        this.reviewedCardList = [];
        this.redoCardList = [];
    }

    // #endregion
}
