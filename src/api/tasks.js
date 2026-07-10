// src/api/tasks.js
// ── Tasks & Notes CRUD API ───────────────────────────────────────────────────
//
// Endpoints for the Notes & Tasks Manager frontend.
// Uses existing DB methods; adds thin wrappers for missing operations.

const db = require('../db');
const { logger } = require('../utils/logger');

// ── Tasks ────────────────────────────────────────────────────────────────────

async function listTasks(req, res) {
  try {
    const ownerId = req.user.sub;
    const { status } = req.query;

    let tasks;
    if (status) {
      tasks = await db.getTasksByStatus(ownerId, status);
    } else {
      // Get all: combine active + each status
      const allStatuses = ['pending', 'in_progress', 'done', 'cancelled'];
      const results = await Promise.all(
        allStatuses.map(s => db.getTasksByStatus(ownerId, s).catch(() => []))
      );
      tasks = results.flat();
    }

    res.json({ tasks: tasks || [] });
  } catch (err) {
    logger.error('List tasks error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function createTask(req, res) {
  try {
    const ownerId = req.user.sub;
    const { title, description, priority, dueDate, goalId } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const task = await db.createTask(
      ownerId,
      title,
      description || '',
      priority || 'medium',
      dueDate || null,
      goalId || null
    );

    logger.info('Task created', { userId: ownerId, taskId: task.id, title });
    res.status(201).json({ task });
  } catch (err) {
    logger.error('Create task error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function updateTask(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Map frontend field names to DB column names
    const dbUpdates = {};
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.priority !== undefined) dbUpdates.priority = updates.priority;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.dueDate !== undefined) dbUpdates.due_date = updates.dueDate;
    if (updates.goalId !== undefined) dbUpdates.goal_id = updates.goalId;

    if (Object.keys(dbUpdates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const task = await db.updateTask(id, dbUpdates);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({ task });
  } catch (err) {
    logger.error('Update task error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function deleteTask(req, res) {
  try {
    const { id } = req.params;
    // Soft-delete: cancel the task
    const task = await db.cancelTask(id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json({ success: true, task });
  } catch (err) {
    logger.error('Delete task error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Notes ────────────────────────────────────────────────────────────────────

async function listNotes(req, res) {
  try {
    const ownerId = req.user.sub;
    const { limit } = req.query;
    const notes = await db.getRecentNotes(ownerId, parseInt(limit) || 50);
    res.json({ notes: notes || [] });
  } catch (err) {
    logger.error('List notes error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function createNote(req, res) {
  try {
    const ownerId = req.user.sub;
    const { content, title } = req.body;

    if (!content && !title) {
      return res.status(400).json({ error: 'content or title is required' });
    }

    // Store title as first line of content or as-is
    const noteContent = title ? `# ${title}\n\n${content || ''}` : content;
    const note = await db.addNote(ownerId, noteContent);
    logger.info('Note created', { userId: ownerId, noteId: note.id });
    res.status(201).json({ note });
  } catch (err) {
    logger.error('Create note error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function updateNote(req, res) {
  try {
    const ownerId = req.user.sub;
    const { id } = req.params;
    const { content, title } = req.body;

    // Notes don't have a dedicated update method — delete + recreate
    // First get the existing note to verify ownership
    const existingNotes = await db.getRecentNotes(ownerId, 100);
    const existing = existingNotes.find(n => String(n.id) === String(id));
    if (!existing) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Build new content
    let newContent = content;
    if (title) {
      // Check if existing content had a title prefix
      const existingTitle = existing.content.startsWith('# ') ? existing.content.split('\n')[0].replace('# ', '') : '';
      if (existingTitle && !content) {
        // Keep existing content but update title
        const bodyLines = existing.content.split('\n').slice(1).join('\n');
        newContent = `# ${title}\n\n${bodyLines}`;
      } else if (title && content) {
        newContent = `# ${title}\n\n${content}`;
      }
    }

    // Delete old, create new (simplified — in production you'd use UPDATE)
    await db.deleteNote(id);
    const note = await db.addNote(ownerId, newContent || existing.content);

    res.json({ note });
  } catch (err) {
    logger.error('Update note error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function deleteNote(req, res) {
  try {
    const { id } = req.params;
    await db.deleteNote(id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Delete note error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Goals ────────────────────────────────────────────────────────────────────

async function listGoals(req, res) {
  try {
    const ownerId = req.user.sub;
    const goals = await db.getAllGoals(ownerId);
    res.json({ goals: goals || [] });
  } catch (err) {
    logger.error('List goals error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function createGoal(req, res) {
  try {
    const ownerId = req.user.sub;
    const { title, description, targetDate } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const goal = await db.createGoal(ownerId, title, description || '', targetDate || null);
    logger.info('Goal created', { userId: ownerId, goalId: goal.id, title });
    res.status(201).json({ goal });
  } catch (err) {
    logger.error('Create goal error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function updateGoal(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Map frontend field names to DB column names
    const dbUpdates = {};
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.progress !== undefined) dbUpdates.progress = updates.progress;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.targetDate !== undefined) dbUpdates.target_date = updates.targetDate;

    if (Object.keys(dbUpdates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const goal = await db.updateGoal(id, dbUpdates);
    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    res.json({ goal });
  } catch (err) {
    logger.error('Update goal error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

async function deleteGoal(req, res) {
  try {
    const { id } = req.params;
    const goal = await db.abandonGoal(id);
    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    res.json({ success: true, goal });
  } catch (err) {
    logger.error('Delete goal error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  listTasks, createTask, updateTask, deleteTask,
  listNotes, createNote, updateNote, deleteNote,
  listGoals, createGoal, updateGoal, deleteGoal,
};
