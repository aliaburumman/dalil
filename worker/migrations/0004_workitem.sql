-- Azure DevOps work item for a report. NULL = none, 'pending:<epoch ms>' = being created, otherwise the work item URL.
ALTER TABLE reports ADD COLUMN workitem_url TEXT;
