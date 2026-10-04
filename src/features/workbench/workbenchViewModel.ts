import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createId,
  createInitialDocument,
  createPlan,
  type DeskItem,
  type DeviceType,
  type LayoutAnalysis,
  type WorkspaceDocument,
  type WorkspacePlan,
  type WorkspaceStatus,
} from '../../shared/models'
import { clampDeskSize, clampItemDimension } from '../../shared/layoutRules'
import { moveCanvasItem, rotateCanvasItem } from '../canvas/canvasViewModel'
import { createMaterialDraft } from '../materials/materialsViewModel'
import { inspectPlan } from '../inspection/inspectionViewModel'
import { LocalWorkspaceRepository, type WorkspaceRepository } from './workspaceRepository'
import { DebouncedSaveQueue } from './saveQueue'

export interface WorkspaceViewModel {
  status: WorkspaceStatus
  document: WorkspaceDocument | null
  activePlan: WorkspacePlan | null
  selectedItem: DeskItem | null
  analysis: LayoutAnalysis
  issueIds: string[]
  issueCount: number
  feedback: string
  saveFeedback: string | null
  isPreviewOpen: boolean
  selectItem: (id: string | null) => void
  addItem: (type: DeviceType) => void
  removeItem: (id: string) => void
  moveItem: (id: string, x: number, y: number) => void
  rotateItem: (id: string, delta: number) => void
  updateItem: (id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => void
  updateDesk: (field: 'deskWidthMm' | 'deskHeightMm', value: number) => void
  createNewPlan: () => void
  duplicatePlan: () => void
  selectPlan: (id: string) => void
  deleteCurrentPlan: () => void
  openPreview: () => void
  closePreview: () => void
}

const emptyInspection = { analysis: { overlapIds: [], outOfBoundsIds: [], coveragePercent: 0, status: 'clear' as const }, issueIds: [], issueCount: 0 }

export function useWorkspaceViewModel(repository?: WorkspaceRepository): WorkspaceViewModel {
  const repositoryRef = useRef(repository ?? new LocalWorkspaceRepository())
  const [status, setStatus] = useState<WorkspaceStatus>('loading')
  const [documentState, setDocumentState] = useState<WorkspaceDocument | null>(null)
  const documentRef = useRef<WorkspaceDocument | null>(null)
  const queueRef = useRef<DebouncedSaveQueue | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [feedback, setFeedback] = useState('正在准备你的工作台…')
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)

  useEffect(() => {
    queueRef.current = new DebouncedSaveQueue(repositoryRef.current, {
      onStatusChange: (nextStatus) => {
        setStatus(nextStatus)
        if (nextStatus === 'error') {
          setSaveFeedback('自动保存失败，请检查浏览器本地存储权限')
        } else if (nextStatus === 'ready') {
          setSaveFeedback(null)
        }
      },
    })
    return () => queueRef.current?.dispose()
  }, [])

  useEffect(() => {
    let active = true
    void repositoryRef.current.load().then((loaded) => {
      if (!active) return
      const nextDocument = loaded ?? createInitialDocument()
      documentRef.current = nextDocument
      setDocumentState(nextDocument)
      setStatus('ready')
      setFeedback(loaded ? '已恢复上次编辑状态' : '已创建示例工作台，可以直接拖动设备')
    }).catch(() => {
      if (!active) return
      const nextDocument = createInitialDocument()
      documentRef.current = nextDocument
      setDocumentState(nextDocument)
      setStatus('error')
      setFeedback('本地数据读取失败，当前使用临时工作台')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const flushBeforeUnload = () => {
      queueRef.current?.flushSync((nextDocument) => repositoryRef.current.saveSync(nextDocument))
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushBeforeUnload()
    }

    window.addEventListener('pagehide', flushBeforeUnload)
    window.addEventListener('beforeunload', flushBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flushBeforeUnload)
      window.removeEventListener('beforeunload', flushBeforeUnload)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  const activePlan = useMemo(
    () => documentState?.plans.find((plan) => plan.id === documentState.activePlanId) ?? null,
    [documentState],
  )
  const selectedItem = activePlan?.items.find((item) => item.id === selectedItemId) ?? null
  const inspection = useMemo(() => activePlan ? inspectPlan(activePlan) : emptyInspection, [activePlan])
  const { analysis, issueIds, issueCount } = inspection

  const commitDocument = useCallback((nextDocument: WorkspaceDocument, message: string) => {
    const queue = queueRef.current
    if (!queue) return

    const revision = Math.max(nextDocument.revision ?? 0, documentRef.current?.revision ?? 0) + 1
    const stampedDocument = { ...nextDocument, updatedAt: new Date().toISOString(), revision }
    documentRef.current = stampedDocument
    setDocumentState(stampedDocument)
    setSaveFeedback(null)
    setFeedback(message)
    queue.enqueue(stampedDocument)
  }, [])

  const updateActivePlan = useCallback((updater: (plan: WorkspacePlan) => WorkspacePlan, message: string) => {
    const currentDocument = documentRef.current
    const currentPlan = currentDocument?.plans.find((plan) => plan.id === currentDocument.activePlanId)
    if (!currentDocument || !currentPlan) return
    const nextPlan = { ...updater(currentPlan), updatedAt: new Date().toISOString() }
    const nextDocument = {
      ...currentDocument,
      plans: currentDocument.plans.map((plan) => plan.id === nextPlan.id ? nextPlan : plan),
    }
    commitDocument(nextDocument, message)
  }, [commitDocument])

  const selectItem = useCallback((id: string | null) => setSelectedItemId(id), [])

  const addItem = useCallback((type: DeviceType) => {
    const currentDocument = documentRef.current
    const currentPlan = currentDocument?.plans.find((plan) => plan.id === currentDocument.activePlanId)
    if (!currentDocument || !currentPlan) return
    const draft = createMaterialDraft(type, currentPlan.items.length)
    commitDocument({
      ...currentDocument,
      plans: currentDocument.plans.map((plan) => plan.id === currentPlan.id
        ? { ...plan, items: [...plan.items, draft.item], updatedAt: new Date().toISOString() }
        : plan),
    }, draft.feedback)
    setSelectedItemId(draft.item.id)
  }, [commitDocument])

  const removeItem = useCallback((id: string) => {
    updateActivePlan((plan) => ({ ...plan, items: plan.items.filter((item) => item.id !== id) }), '设备已移除')
    setSelectedItemId((current) => current === id ? null : current)
  }, [updateActivePlan])

  const moveItem = useCallback((id: string, x: number, y: number) => {
    updateActivePlan((plan) => ({ ...plan, items: moveCanvasItem(plan.items, id, x, y) }), '位置已更新')
  }, [updateActivePlan])

  const rotateItem = useCallback((id: string, delta: number) => {
    updateActivePlan((plan) => ({ ...plan, items: rotateCanvasItem(plan.items, id, delta) }), '角度已更新')
  }, [updateActivePlan])

  const updateItem = useCallback((id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => {
    updateActivePlan((plan) => ({
      ...plan,
      items: plan.items.map((item) => item.id === id ? {
        ...item,
        ...patch,
        widthMm: patch.widthMm === undefined ? item.widthMm : clampItemDimension(patch.widthMm, item.widthMm),
        heightMm: patch.heightMm === undefined ? item.heightMm : clampItemDimension(patch.heightMm, item.heightMm),
      } : item),
    }), '尺寸参数已更新')
  }, [updateActivePlan])

  const updateDesk = useCallback((field: 'deskWidthMm' | 'deskHeightMm', value: number) => {
    const currentDocument = documentRef.current
    const currentPlan = currentDocument?.plans.find((plan) => plan.id === currentDocument.activePlanId)
    if (!currentDocument || !currentPlan) return
    commitDocument({
      ...currentDocument,
      plans: currentDocument.plans.map((plan) => plan.id === currentPlan.id
        ? { ...plan, [field]: clampDeskSize(value, plan[field]), updatedAt: new Date().toISOString() }
        : plan),
    }, '桌面尺寸已更新')
  }, [commitDocument])

  const createNewPlan = useCallback(() => {
    const currentDocument = documentRef.current
    if (!currentDocument) return
    const plan = createPlan(`工作台 ${currentDocument.plans.length + 1}`, false)
    commitDocument({ ...currentDocument, plans: [...currentDocument.plans, plan], activePlanId: plan.id }, '已创建空白方案')
    setSelectedItemId(null)
  }, [commitDocument])

  const duplicatePlan = useCallback(() => {
    const currentDocument = documentRef.current
    const currentPlan = currentDocument?.plans.find((plan) => plan.id === currentDocument.activePlanId)
    if (!currentDocument || !currentPlan) return
    const copy: WorkspacePlan = {
      ...currentPlan,
      id: createId('plan'),
      name: `${currentPlan.name} · 副本`,
      items: currentPlan.items.map((item) => ({ ...item, id: createId('item') })),
      updatedAt: new Date().toISOString(),
    }
    commitDocument({ ...currentDocument, plans: [...currentDocument.plans, copy], activePlanId: copy.id }, '方案已复制')
    setSelectedItemId(null)
  }, [commitDocument])

  const selectPlan = useCallback((id: string) => {
    const currentDocument = documentRef.current
    if (!currentDocument || !currentDocument.plans.some((plan) => plan.id === id)) return
    commitDocument({ ...currentDocument, activePlanId: id }, '已切换方案')
    setSelectedItemId(null)
  }, [commitDocument])

  const deleteCurrentPlan = useCallback(() => {
    const currentDocument = documentRef.current
    const currentPlan = currentDocument?.plans.find((plan) => plan.id === currentDocument.activePlanId)
    if (!currentDocument || !currentPlan || currentDocument.plans.length <= 1) {
      setFeedback('至少保留一个工作台方案')
      return
    }
    const remaining = currentDocument.plans.filter((plan) => plan.id !== currentPlan.id)
    commitDocument({ ...currentDocument, plans: remaining, activePlanId: remaining[0].id }, '方案已删除')
    setSelectedItemId(null)
  }, [commitDocument])

  const openPreview = useCallback(() => setIsPreviewOpen(true), [])
  const closePreview = useCallback(() => setIsPreviewOpen(false), [])

  return {
    status,
    document: documentState,
    activePlan,
    selectedItem,
    analysis,
    issueIds,
    issueCount,
    feedback,
    saveFeedback,
    isPreviewOpen,
    selectItem,
    addItem,
    removeItem,
    moveItem,
    rotateItem,
    updateItem,
    updateDesk,
    createNewPlan,
    duplicatePlan,
    selectPlan,
    deleteCurrentPlan,
    openPreview,
    closePreview,
  }
}
