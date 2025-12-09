# Redo 功能實作規格

## 一、核心概念

### 兩個列表的職責

- `reviewedCardList` - 暫存所有已複習的卡片（用於 undo）
- `redoCardList` - 被 redo 回來的卡片（用於 UI 優先顯示）

### 污染策略

- UI 層優先從 `redoCardList` 取卡片（peek，不 pop）
- 只在適當時機 pop（processReview 或 processRedo）
- DataStore 層只負責檔案寫入，不改 deck tree

---

## 二、FlashcardReviewSequencer 改動

### 2.1 新增資料結構

```typescript
export interface ReviewUndoData {
    card: Card;
    question: Question;
    hadScheduleBeforeReview: boolean;
    oldScheduleInfo: RepItemScheduleInfo | null;
}

export interface IFlashcardReviewSequencer {
    // ...existing code...
    processReview(response: ReviewResponse): Promise<void>;

    // 新增方法
    canRedo(): boolean;
    peekRedoCard(): { card: Card; question: Question } | null;
    processRedo(): Promise<void>;
    clearRedoLists(): void;
}

export class FlashcardReviewSequencer implements IFlashcardReviewSequencer {
    // 新增兩個列表
    private reviewedCardList: ReviewUndoData[] = [];
    private redoCardList: ReviewUndoData[] = [];

    // ...existing code...
}
```

### 2.2 修改 processReview

```typescript
async processReview(response: ReviewResponse): Promise<void> {
    // 檢查是否在處理 redo 卡片
    if (this.redoCardList.length > 0) {
        // Pop redo 卡片
        const redoCard = this.redoCardList.pop()!;

        switch (this.reviewMode) {
            case FlashcardReviewMode.Review:
                // 備份舊的 schedule（複習前的狀態）
                const oldScheduleInfo = structuredClone(redoCard.card.scheduleInfo);

                // 計算並寫入新的 schedule
                redoCard.card.scheduleInfo = this.determineCardSchedule(response, redoCard.card);
                await DataStore.getInstance().questionWriteSchedule(redoCard.question);

                // 備份到 reviewedCardList（存舊 schedule）
                this.reviewedCardList.push({
                    card: structuredClone(redoCard.card),
                    question: redoCard.question,
                    hadScheduleBeforeReview: true,  // redo 卡片一定已經有 schedule
                    oldScheduleInfo: oldScheduleInfo,  // 存舊的，不是新的！
                });

                // 直接 return，不走原本流程
                // UI 層的 _showNextCard() 會自動處理下一張
                return;

            case FlashcardReviewMode.Cram:
                // Cram mode 不寫檔案，只 pop
                // UI 層的 _showNextCard() 會自動處理下一張
                return;
        }
    }

    // 正常流程：備份當前卡片
    const oldScheduleInfo = structuredClone(this.currentCard.scheduleInfo);
    this.reviewedCardList.push({
        card: structuredClone(this.currentCard),
        question: this.currentQuestion,
        hadScheduleBeforeReview: this.currentCard.hasSchedule,
        oldScheduleInfo: oldScheduleInfo,
    });

    // 執行原本邏輯
    switch (this.reviewMode) {
        case FlashcardReviewMode.Review:
            await this.processReviewReviewMode(response);
            break;
        case FlashcardReviewMode.Cram:
            await this.processReviewCramMode(response);
            break;
    }
}
```

### 2.3 新增 processRedo

```typescript
async processRedo(): Promise<void> {
    if (this.reviewedCardList.length === 0) return;

    // Pop 最後一張已複習卡片
    const undoData = this.reviewedCardList.pop()!;

    // 還原舊 schedule
    if (!undoData.hadScheduleBeforeReview) {
        undoData.card.scheduleInfo = null;
    } else {
        undoData.card.scheduleInfo = undoData.oldScheduleInfo;
    }

    // 寫回檔案
    await DataStore.getInstance().questionWriteSchedule(undoData.question);

    // Push 到 redoCardList
    this.redoCardList.push(undoData);
}
```

### 2.4 新增輔助方法

```typescript
/**
 * 檢查是否可以 redo
 */
canRedo(): boolean {
    return this.reviewedCardList.length > 0;
}

/**
 * Peek redo 卡片（返回副本，不暴露內部結構）
 */
peekRedoCard(): { card: Card; question: Question } | null {
    if (this.redoCardList.length === 0) return null;

    const undoData = this.redoCardList[this.redoCardList.length - 1];
    // 返回副本，不暴露原始物件
    return {
        card: structuredClone(undoData.card),
        question: undoData.question,
    };
}

/**
 * 取得 redo 卡片數量
 */
getRedoCardCount(): number {
    return this.redoCardList.length;
}

/**
 * 清空所有 redo 列表（session 結束時呼叫）
 */
clearRedoLists(): void {
    this.reviewedCardList = [];
    this.redoCardList = [];
}
```

---

## 三、CardUI 改動

### 3.1 新增 UI 元素

```typescript
export class CardUI {
    // ...existing code...

    public redoButton: HTMLButtonElement;

    // ...existing code...
}
```

### 3.2 建立 Redo 按鈕

```typescript
private _createCardControls() {
    this._createEditButton();
    this._createResetButton();
    this._createRedoButton();  // 新增
    this._createCardInfoButton();
    this._createSkipButton();
}

private _createRedoButton() {
    this.redoButton = this.controls.createEl("button");
    this.redoButton.addClasses(["sr-button", "sr-redo-button"]);
    setIcon(this.redoButton, "undo-2");
    this.redoButton.setAttribute("aria-label", "Undo Last Review");
    this.redoButton.disabled = true;
    this.redoButton.addEventListener("click", async () => {
        await this._processRedo();
    });
}
```

### 3.3 新增 \_processRedo

```typescript
private async _processRedo(): Promise<void> {
    if (!this.reviewSequencer.canRedo()) return;

    await this.reviewSequencer.processRedo();
    await this._showNextCard();
}
```

### 3.4 污染 \_drawContent

```typescript
private async _drawContent() {
    this.resetButton.disabled = true;

    // 污染：優先從 redoCardList 取卡片（peek）
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

    await wrapper.renderMarkdownWrapper(
        cardData.card.front.trimStart(),
        this.content,
        cardData.question.questionText.textDirection,
    );

    // Auto-play audio in front card
    if (this.settings.autoPlayAudioOnFront) {
        this._autoplayAudio(this.content, this.settings.audioIndexOnFront);
    }

    // Set scroll position back to top
    this.content.scrollTop = 0;

    // Update response buttons
    this._resetResponseButtons();

    // 更新 Redo 按鈕狀態
    this.redoButton.disabled = !this.reviewSequencer.canRedo();
}

/**
 * 污染函數：優先從 redoCardList 取卡片（peek，返回副本）
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

    // 走原本的 sequencer 流程
    return {
        card: this._currentCard,
        question: this._currentQuestion,
        note: this._currentNote,
    };
}
```

### 3.5 更新計數顯示（加註解標記污染）

```typescript
private _updateChosenDeckInfo(chosenDeck: Deck) {
    const chosenDeckStats = this.reviewSequencer.getDeckStats(chosenDeck.getTopicPath());
    this.chosenDeckName.setText(`${chosenDeck.deckName}`);

    // 污染：加入 redo 卡片數量到總卡片數
    const redoCount = this.reviewSequencer.getRedoCardCount();
    const completed = this.totalCardsInSession - chosenDeckStats.cardsInQueueCount;
    const total = this.totalCardsInSession + redoCount;

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

        // 污染：加入 redo 卡片數量到當前 deck 總數
        const redoCount = this.reviewSequencer.getRedoCardCount();
        const completed = this.currentDeckTotalCardsInQueue - currentDeckStats.cardsInQueueOfThisDeckCount;
        const total = this.currentDeckTotalCardsInQueue + redoCount;

        this.currentDeckCardCounter.setText(`${completed}/${total}`);
    }
}
```

### 3.6 清空列表

```typescript
async show(chosenDeck: Deck) {
    if (!this.view.hasClass("sr-is-hidden")) {
        return;
    }

    this.chosenDeck = chosenDeck;
    const deckStats = this.reviewSequencer.getDeckStats(chosenDeck.getTopicPath());
    this.totalCardsInSession = deckStats.cardsInQueueCount;
    this.totalDecksInSession = deckStats.decksInQueueOfThisDeckCount;

    // 清空 redo 列表
    this.reviewSequencer.clearRedoLists();

    await this._drawContent();

    this.view.removeClass("sr-is-hidden");
    document.addEventListener("keydown", this._keydownHandler);
}

close() {
    this.hide();
    document.removeEventListener("keydown", this._keydownHandler);

    // 清空列表
    this.reviewSequencer.clearRedoLists();
}
```

### 3.7 鍵盤快捷鍵

```typescript
private _keydownHandler = (e: KeyboardEvent) => {
    // ...existing code...

    switch (e.code) {
        // ...existing cases...

        case "KeyZ":
            if ((e.ctrlKey || e.metaKey) && this.reviewSequencer.canRedo()) {
                this._processRedo();
                consumeKeyEvent();
            }
            break;

        // ...existing cases...
    }
};
```

---

## 四、完整流程圖

### 場景 1：正常複習

```
_processReview(Good)
  → reviewedCardList.push({ oldScheduleInfo: 舊 schedule })
  → processReviewReviewMode() 寫新 schedule
  → _showNextCard() → refresh() → _drawContent 取 sequencer.currentCard
```

### 場景 2：Redo

```
_processRedo()
  → reviewedCardList.pop()
  → 還原舊 schedule 寫檔案
  → redoCardList.push()
  → _showNextCard() → refresh() → _drawContent 從 peekRedoCard() 取
```

### 場景 3：Re-review redo 卡片

```
_processReview(Good)
  → 檢測到 redoCardList.length > 0
  → redoCardList.pop()
  → 備份舊 schedule 到 oldScheduleInfo
  → 寫新 schedule
  → reviewedCardList.push({ oldScheduleInfo: 舊 schedule })
  → return（不走原本流程）
  → _showNextCard() → refresh() → _drawContent
    → peekRedoCard() 返回 null（因為已 pop）
    → 取 sequencer.currentCard（回到原本流程）
```

---

## 五、關鍵設計決策總結

| 問題                       | 解決方案                                                     |
| -------------------------- | ------------------------------------------------------------ |
| **問題 1：暴露內部結構**   | `peekRedoCard()` 返回 `structuredClone()` 副本               |
| **問題 2：UI 計數污染**    | 所有顯示卡片計數的地方都加上 `getRedoCardCount()`，並加註解  |
| **問題 3：Re-review 流程** | `processReview()` 中 `return` 後，`_showNextCard()` 自動處理 |
| **問題 4：備份邏輯**       | 永遠備份「舊 schedule」到 `reviewedCardList`                 |
| **問題 5：整體流程**       | 依照問題 1-4 優化，邏輯清晰                                  |

---

## 六、實作檢查清單

### FlashcardReviewSequencer

- [ ] 新增 `ReviewUndoData` 介面
- [ ] 新增 `reviewedCardList` 和 `redoCardList` 屬性
- [ ] 修改 `processReview()` 方法（處理 redo 卡片邏輯）
- [ ] 新增 `processRedo()` 方法
- [ ] 新增 `canRedo()` 方法
- [ ] 新增 `peekRedoCard()` 方法
- [ ] 新增 `getRedoCardCount()` 方法
- [ ] 新增 `clearRedoLists()` 方法
- [ ] 更新 `IFlashcardReviewSequencer` 介面

### CardUI

- [ ] 新增 `redoButton` 屬性
- [ ] 新增 `_createRedoButton()` 方法
- [ ] 修改 `_createCardControls()` 呼叫 `_createRedoButton()`
- [ ] 新增 `_processRedo()` 方法
- [ ] 新增 `_getCardData()` 污染函數
- [ ] 修改 `_drawContent()` 使用 `_getCardData()`
- [ ] 修改 `_drawContent()` 更新 Redo 按鈕狀態
- [ ] 修改 `_updateChosenDeckInfo()` 加入 redo 計數
- [ ] 修改 `_updateCurrentDeckInfo()` 加入 redo 計數
- [ ] 修改 `show()` 清空 redo 列表
- [ ] 修改 `close()` 清空 redo 列表
- [ ] 修改 `_keydownHandler` 加入 Ctrl+Z/Cmd+Z 快捷鍵

---

## 七、測試場景

### 基本功能測試

1. **正常複習流程**
    - 複習 3 張卡片（Hard, Good, Easy）
    - 確認 `reviewedCardList` 有 3 張卡片
    - 確認 Redo 按鈕啟用

2. **單次 Redo**
    - 按 Redo 按鈕
    - 確認顯示上一張卡片
    - 確認檔案中的 schedule 標記被還原
    - 確認 `redoCardList` 有 1 張卡片

3. **Re-review Redo 卡片**
    - 對 redo 回來的卡片按 Good
    - 確認寫入新的 schedule
    - 確認回到原本的 sequencer 流程
    - 確認 `reviewedCardList` 備份了舊 schedule

### 邊界測試

4. **連續 Redo**
    - 複習 5 張卡片
    - 連續 Redo 5 次
    - 確認每次都正確顯示

5. **Redo 後關閉 Session**
    - Redo 1 張卡片
    - 關閉 flashcard view
    - 重新開啟
    - 確認列表已清空

6. **Cram Mode**
    - 在 Cram Mode 複習卡片
    - Redo
    - 確認不寫檔案

### UI 測試

7. **計數顯示**
    - 複習 3 張，Redo 2 張
    - 確認 `chosenDeckCardCounter` 顯示正確（總數 +2）
    - 確認 `currentDeckCardCounter` 顯示正確

8. **鍵盤快捷鍵**
    - Ctrl+Z (Windows/Linux) 或 Cmd+Z (Mac)
    - 確認觸發 Redo

### 錯誤處理

9. **空列表時按 Redo**
    - Session 開始時按 Redo
    - 確認無反應，按鈕禁用

10. **Mixed Deck 場景**
    - 在有子 deck 的情況下複習
    - Redo
    - 確認不影響 deck tree 結構
