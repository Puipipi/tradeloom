package io.github.ccch1mneyyy.dsh_app.pet

import org.junit.Assert.*
import org.junit.Test

class PetActionStateTest {
    @Test fun reopeningDuringSendKeepsBusyAndClearsTheSharedDraftOnSuccess() {
        val draft = PetAskDraft()
        draft.edit("first question")
        val send = draft.beginSend("first question")!!
        // Closing and recreating a bar copies the same draft, not a new edit.
        draft.edit(draft.text)
        assertTrue(draft.sending)
        assertNull(draft.beginSend("first question"))
        assertTrue(draft.finish(send, accepted = true)!!.cleared)
        assertFalse(draft.sending)
        assertEquals("", draft.text)
    }

    @Test fun aNewEditIsNeverClearedByAnEarlierAcknowledgement() {
        val draft = PetAskDraft()
        draft.edit("first question")
        val send = draft.beginSend("first question")!!
        draft.edit("next question")
        // Even changing back to identical text is a new edit with a new identity.
        draft.edit("first question")
        assertFalse(draft.finish(send, accepted = true)!!.cleared)
        assertEquals("first question", draft.text)
    }

    @Test fun failedSendKeepsDraftAndCanRetry() {
        val draft = PetAskDraft()
        draft.edit("question")
        val send = draft.beginSend("question")!!
        assertFalse(draft.finish(send, accepted = false)!!.cleared)
        assertEquals("question", draft.text)
        assertNotNull(draft.beginSend("question"))
    }

    @Test fun producerResetRetiresOldSendAndCannotClearItsReplacement() {
        val draft = PetAskDraft()
        draft.edit("question")
        val old = draft.beginSend("question")!!
        draft.resetProducer()
        val current = draft.beginSend("question")!!
        assertNull(draft.finish(old, accepted = true))
        assertTrue(draft.sending)
        assertEquals("question", draft.text)
        assertTrue(draft.finish(current, accepted = true)!!.cleared)
    }

    @Test fun producerResetReleasesPendingApprovalWithoutItsCallback() {
        val answers = PetAnswerState()
        answers.begin("old")!!
        assertNull(answers.begin("another"))
        answers.reset()
        assertNull(answers.bubbleId)
        assertNotNull(answers.begin("another"))
    }

    @Test fun oldAnswerCannotCompleteANewOwnerEvenWithTheSameBubbleId() {
        val answers = PetAnswerState()
        val old = answers.begin("same-id")!!
        answers.reset()
        val current = answers.begin("same-id")!!
        assertFalse(answers.finish(old))
        assertEquals("same-id", answers.bubbleId)
        assertTrue(answers.finish(current))
        assertNull(answers.bubbleId)
    }
}
