/*
 * cloudbeaver - Cloud Database Manager
 * Copyright (C) 2020 DBeaver Corp and others
 *
 * Licensed under the Apache License, Version 2.0.
 * you may not use this file except in compliance with the License.
 */

import { observable } from 'mobx';

import { ErrorDetailsDialog } from '@dbeaver/core/app';
import { IDestructibleController, IInitializableController, injectable } from '@dbeaver/core/di';
import { CommonDialogService } from '@dbeaver/core/dialogs';
import { NotificationService } from '@dbeaver/core/eventsLog';
import { GQLError, ServerInternalError } from '@dbeaver/core/sdk';
import { PromiseCancelledError } from '@dbeaver/core/utils';
import {
  fetchingSettings,
  IRequestDataResult,
  ITableViewerModelInit, RowDiff,
  TableViewerModel,
  TableViewerStorageService,
} from '@dbeaver/data-viewer-plugin';

import { ISqlResultPanelParams } from '../../ISqlEditorTabState';
import { SqlExecutionState } from '../../SqlExecutionState';
import { SqlResultService } from '../SqlResultService';

export enum EPanelState {
  PENDING = 'PENDING',
  ERROR = 'ERROR',
  MESSAGE_RESULT = 'MESSAGE_RESULT',
  TABLE_RESULT = 'TABLE_RESULT',
}

@injectable()
export class SqlResultPanelController
implements IInitializableController<[ISqlResultPanelParams]>, IDestructibleController {

  @observable state: EPanelState = EPanelState.PENDING;
  @observable executionResult = '';
  @observable errorMessage?: string;
  @observable hasDetails = false;

  private exception: Error | null = null;
  private panelInit!: ISqlResultPanelParams;

  constructor(private sqlResultService: SqlResultService,
              private tableViewerStorageService: TableViewerStorageService,
              private commonDialogService: CommonDialogService,
              private notificationService: NotificationService) {
  }

  async init(panelInit: ISqlResultPanelParams) {
    this.panelInit = panelInit;

    try {
      const response = await this.panelInit.firstDataPortion.promise;

      const dataSet = response.results![panelInit.indexInResultSet];

      if (!dataSet) {
        throw new Error(`dataset not found: ${panelInit.indexInResultSet}`);
      }

      if (!dataSet.resultSet) {
        this.state = EPanelState.MESSAGE_RESULT;
        this.executionResult = `Query executed: ${response.statusMessage || ''} (${response.duration} ms)`;

      } else {
        this.state = EPanelState.TABLE_RESULT;
        this.panelInit.resultId = dataSet.resultSet.id;
        const initialState = this.sqlResultService
          .sqlExecuteInfoToData(response, this.panelInit.indexInResultSet, fetchingSettings.fetchDefault);
        this.createTableModel(initialState, panelInit.sqlExecutionState);
      }

    } catch (exception) {
      if (exception instanceof PromiseCancelledError) {
        this.state = EPanelState.MESSAGE_RESULT;
        this.executionResult = 'Query execution cancelled';
        return;
      }

      this.state = EPanelState.ERROR;
      this.exception = null;
      this.hasDetails = false;

      if (exception instanceof ServerInternalError) {
        this.errorMessage = exception.message;
        this.exception = exception;
        this.hasDetails = !!exception.stackTrace;
      }
      else if (exception instanceof GQLError) {
        this.errorMessage = exception.errorText;
        this.exception = exception;
        this.hasDetails = exception.hasDetails();
      } else {
        this.notificationService.logException(exception, 'Error while processing SQL query result');
        this.errorMessage = exception.message;
      }
    }

  }

  getQuery(): string {
    return this.panelInit.sqlQueryParams.query;
  }

  destruct() {
    if (this.state === EPanelState.TABLE_RESULT) {
      this.tableViewerStorageService.removeTableModel(this.getTableId());
    }
  }

  getTableId() {
    return this.panelInit.resultTabId;
  }

  onShowDetails = () => {
    if (this.exception) {
      this.commonDialogService.open(ErrorDetailsDialog, this.exception);
    }
  }

  private createTableModel(initialState: IRequestDataResult, sqlExecutingState: SqlExecutionState): void {
    const callbacks: ITableViewerModelInit = {
      initialState,
      requestDataAsync: this.requestDataAsync.bind(this, sqlExecutingState),
      noLoaderWhileRequestingDataAsync: true,
      saveChanges: this.saveChanges.bind(this),
    };
    const table = new TableViewerModel(callbacks, this.commonDialogService);
    this.tableViewerStorageService.addTableModel(this.getTableId(), table);
  }

  private async requestDataAsync(sqlExecutingState: SqlExecutionState,
                                 rowOffset: number,
                                 count: number): Promise<IRequestDataResult> {

    const queryExecutionProcess = this.sqlResultService.asyncSqlQuery(this.panelInit.sqlQueryParams, rowOffset, count);
    sqlExecutingState.setCurrentlyExecutingQuery(queryExecutionProcess);
    const response = await queryExecutionProcess.promise;
    const dataResults = this.sqlResultService.sqlExecuteInfoToData(response, this.panelInit.indexInResultSet, count);

    /**
     * Note that each data fetching overwrites resultId
     */
    const dataSet = response.results![this.panelInit.indexInResultSet]!.resultSet!;
    this.panelInit.resultId = dataSet.id;
    return dataResults;
  }

  async saveChanges(diffs: RowDiff[]): Promise<IRequestDataResult> {

    const resultId = this.panelInit.resultId!; // must be set after first data request;
    const response = await this.sqlResultService.saveChanges(this.panelInit.sqlQueryParams, resultId, diffs);

    return this.sqlResultService.sqlExecuteInfoToData(response, this.panelInit.indexInResultSet);
  }

}
