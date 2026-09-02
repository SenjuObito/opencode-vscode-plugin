import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useDialogResize} from '../hooks/useDialogResize';
import {isEditableEventTarget} from '../utils/isEditableEventTarget';
import {formatCountdown} from '../utils/helpers';
import {useDialogCountdownTimeout} from '../hooks/useDialogCountdownTimeout';
import {useTranslation} from 'react-i18next';
import {DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS} from '../utils/permissionDialogTimeout';
import './AskUserQuestionDialog.css';

const OTHER_OPTION_MARKER = '__OTHER__';
const MAX_CUSTOM_INPUT_LENGTH = 2000;

export interface AskUserQuestionRequest {
  requestId: string;
  toolName: string;
  questions: {
    question: string;
    header: string;
    options?: {label: string; description?: string}[];
    multiSelect?: boolean;
  }[];
  provider?: 'opencode' | 'codex';
}

interface AskUserQuestionDialogProps {
  isOpen: boolean;
  request: AskUserQuestionRequest | null;
  onSubmit: (requestId: string, answers: Record<string, string | string[]>) => void;
  onCancel: (requestId: string) => void;
  onUpdateHeight?: (height: number | null) => void;
  timeoutSeconds?: number;
}

export const AskUserQuestionDialog: React.FC<AskUserQuestionDialogProps> = ({
  isOpen,
  request,
  onSubmit,
  onCancel,
  onUpdateHeight,
  timeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}) => {
  const {t} = useTranslation();
  const {dialogRef, dialogHeight, setDialogHeight, handleResizeStart} = useDialogResize({minHeight: 200});

  const [answers, setAnswers] = useState<Record<string, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const customInputRef = useRef<HTMLTextAreaElement>(null);
  const submittedRef = useRef(false);

  const handleTimeout = useCallback(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    if (request) onCancel(request.requestId);
  }, [request, onCancel]);

  const {remainingSeconds, isTimeWarning, markSubmitted} = useDialogCountdownTimeout({
    isOpen,
    requestKey: request?.requestId,
    timeoutSeconds,
    onTimeout: handleTimeout,
  });

  const normalizedQuestions = useMemo(() => {
    return (request?.questions ?? []).map((q) => ({
      question: q.question ?? '',
      header: q.header ?? '',
      options: (q.options ?? []).map((o) => ({label: o.label ?? '', description: o.description ?? ''})),
      multiSelect: q.multiSelect ?? false,
    }));
  }, [request?.questions]);

  const safeQuestionIndex = Math.max(0, Math.min(currentQuestionIndex, normalizedQuestions.length - 1));
  const currentQuestion = normalizedQuestions[safeQuestionIndex] ?? null;

  const handleCancel = useCallback(() => {
    if (!request || submittedRef.current) return;
    submittedRef.current = true;
    onCancel(request.requestId);
  }, [request, onCancel]);

  const handleOptionToggle = useCallback(
    (label: string) => {
      if (!currentQuestion) return;
      setAnswers((prev) => {
        const newAnswers = {...prev};
        const currentSet = new Set(newAnswers[currentQuestion.question] ?? []);
        if (currentQuestion.multiSelect) {
          if (currentSet.has(label)) currentSet.delete(label);
          else currentSet.add(label);
        } else {
          currentSet.clear();
          currentSet.add(label);
        }
        newAnswers[currentQuestion.question] = currentSet;
        return newAnswers;
      });
      if (label === OTHER_OPTION_MARKER) {
        setTimeout(() => customInputRef.current?.focus(), 0);
      }
    },
    [currentQuestion],
  );

  const handleCustomInputChange = useCallback(
    (value: string) => {
      if (!currentQuestion) return;
      const sanitized = value.slice(0, MAX_CUSTOM_INPUT_LENGTH);
      setCustomInputs((prev) => ({...prev, [currentQuestion.question]: sanitized}));
    },
    [currentQuestion],
  );

  const isOtherSelected = currentQuestion ? answers[currentQuestion.question]?.has(OTHER_OPTION_MARKER) ?? false : false;
  const currentCustomInput = currentQuestion ? customInputs[currentQuestion.question] ?? '' : '';

  const hasRegularSelection = currentQuestion
    ? Array.from(answers[currentQuestion.question] ?? []).some((l) => l !== OTHER_OPTION_MARKER)
    : false;
  const hasValidCustomInput = isOtherSelected && currentCustomInput.trim().length > 0;
  const canProceed = hasRegularSelection || hasValidCustomInput;

  const isLastQuestion = safeQuestionIndex === normalizedQuestions.length - 1;

  const handleSubmitFinal = useCallback(() => {
    if (!request || !markSubmitted()) return;
    const formattedAnswers: Record<string, string | string[]> = {};
    normalizedQuestions.forEach((q) => {
      const selectedSet = answers[q.question] ?? new Set<string>();
      const customText = customInputs[q.question] ?? '';
      const selectedLabels = Array.from(selectedSet).filter((l) => l !== OTHER_OPTION_MARKER);
      if (selectedSet.has(OTHER_OPTION_MARKER) && customText.trim()) {
        selectedLabels.push(customText.trim());
      }
      if (selectedLabels.length > 0) {
        formattedAnswers[q.question] = q.multiSelect ? selectedLabels : selectedLabels[0]!;
      }
    });
    onSubmit(request.requestId, formattedAnswers);
  }, [request, markSubmitted, normalizedQuestions, answers, customInputs, onSubmit]);

  const handleNext = useCallback(() => {
    if (isLastQuestion) handleSubmitFinal();
    else setCurrentQuestionIndex((prev) => prev + 1);
  }, [isLastQuestion, handleSubmitFinal]);

  const handleBack = useCallback(() => {
    setCurrentQuestionIndex((prev) => Math.max(0, prev - 1));
  }, []);

  useEffect(() => {
    if (isOpen && request) {
      submittedRef.current = false;
      const initialAnswers: Record<string, Set<string>> = {};
      const initialCustomInputs: Record<string, string> = {};
      request.questions.forEach((q) => {
        initialAnswers[q.question] = new Set<string>();
        initialCustomInputs[q.question] = '';
      });
      setAnswers(initialAnswers);
      setCustomInputs(initialCustomInputs);
      setDialogHeight(null);
      setCurrentQuestionIndex(0);
    }
  }, [isOpen, request?.requestId, setDialogHeight]);

  useEffect(() => {
    if (onUpdateHeight) onUpdateHeight(dialogHeight);
  }, [dialogHeight, onUpdateHeight]);

  useEffect(() => {
    if (!isOpen || !request) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter' && canProceed) {
        e.preventDefault();
        handleNext();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, request, handleCancel, handleNext, canProceed]);

  if (!isOpen || !request || normalizedQuestions.length === 0 || !currentQuestion) return null;

  return (
    <div
      className={`permission-dialog-overlay ${isTimeWarning ? 'warning-mode' : ''}`}
    >
      <div
        ref={dialogRef}
        className={`ask-user-question-dialog expanded ${isTimeWarning ? 'time-warning' : ''}`}
        style={dialogHeight ? {height: dialogHeight, maxHeight: '90vh'} : undefined}
      >
        <div className="ask-user-question-dialog-resize-handle" onPointerDown={handleResizeStart} />

        <div className="ask-user-question-dialog-header">
          <h3 className="ask-user-question-dialog-title">
            {t('askUserQuestion.title', 'OpenCode 有一些问题想问你')}
          </h3>
          <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
            <span className="codicon codicon-clock" />
            <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
          </span>
        </div>

        <div className="ask-user-question-dialog-progress-row">
          <span className="ask-user-question-dialog-progress">
            {t('askUserQuestion.progress', '问题 {{current}} / {{total}}', {
              current: safeQuestionIndex + 1,
              total: normalizedQuestions.length,
            })}
          </span>
        </div>

        <div className="ask-user-question-dialog-question">
          <div className="question-header">
            {currentQuestion.header && currentQuestion.header !== 'Other' && (
              <span className="question-tag">{currentQuestion.header}</span>
            )}
          </div>
          <p className="question-text">{currentQuestion.question}</p>

          <div className="question-options">
            {currentQuestion.options.map((option) => {
              const isSelected = answers[currentQuestion.question]?.has(option.label) ?? false;
              return (
                <button
                  key={option.label}
                  className={`question-option ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleOptionToggle(option.label)}
                >
                  <div className="option-checkbox">
                    {currentQuestion.multiSelect ? (
                      <span className={`codicon codicon-${isSelected ? 'check' : 'blank'}`} />
                    ) : (
                      <span className={`codicon codicon-${isSelected ? 'circle-filled' : 'circle-outline'}`} />
                    )}
                  </div>
                  <div className="option-content">
                    <div className="option-label">{option.label}</div>
                    {option.description && <div className="option-description">{option.description}</div>}
                  </div>
                </button>
              );
            })}

            <button
              className={`question-option other-option ${isOtherSelected ? 'selected' : ''}`}
              onClick={() => handleOptionToggle(OTHER_OPTION_MARKER)}
            >
              <div className="option-checkbox">
                {currentQuestion.multiSelect ? (
                  <span className={`codicon codicon-${isOtherSelected ? 'check' : 'blank'}`} />
                ) : (
                  <span className={`codicon codicon-${isOtherSelected ? 'circle-filled' : 'circle-outline'}`} />
                )}
              </div>
              <div className="option-content">
                <div className="option-label">{t('askUserQuestion.otherOption', '其他')}</div>
                <div className="option-description">{t('askUserQuestion.otherOptionDesc', '输入自定义答案')}</div>
              </div>
            </button>
          </div>

          {isOtherSelected && (
            <div className="custom-input-container">
              <textarea
                ref={customInputRef}
                className="custom-input"
                value={currentCustomInput}
                onChange={(e) => handleCustomInputChange(e.target.value)}
                placeholder={t('askUserQuestion.customInputPlaceholder', '请输入您的答案...')}
                rows={3}
                maxLength={MAX_CUSTOM_INPUT_LENGTH}
              />
            </div>
          )}

          {currentQuestion.multiSelect && (
            <p className="question-hint">
              {t('askUserQuestion.multiSelectHint', '可以选择多个选项')}
            </p>
          )}
        </div>

        <div className="ask-user-question-dialog-actions">
          <button className="action-button secondary" onClick={handleCancel}>
            {t('askUserQuestion.cancel', '取消')}
          </button>
          <div className="action-buttons-right">
            {safeQuestionIndex > 0 && (
              <button className="action-button secondary" onClick={handleBack}>
                {t('askUserQuestion.back', '上一步')}
              </button>
            )}
            <button
              className={`action-button primary ${!canProceed ? 'disabled' : ''}`}
              onClick={handleNext}
              disabled={!canProceed}
            >
              {isLastQuestion
                ? t('askUserQuestion.submit', '提交')
                : t('askUserQuestion.next', '下一步')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AskUserQuestionDialog;
